"""실제 Node 서버·브라우저 + 로컬 모의 RAG 게이트웨이 가격 회귀.

실행: npm run build 후 python tests/price-e2e.py [캡처 폴더]
실제 모델·외부 환율 API는 호출하지 않는다. FX 응답은 브라우저에서 명시적인 예시로 모의한다.
"""
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import urlopen
import uuid

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
SHOTS = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix="price-e2e-"))
TOKEN = "price-mock-only-token-0123456789abcdef01234567"
posts, jobs, polls, checks = [], {}, [], []


def check(name, condition):
    checks.append((name, bool(condition)))
    print(("PASS " if condition else "FAIL ") + name, flush=True)
    if not condition:
        raise AssertionError(name)


class Gateway(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def authorized(self):
        return self.headers.get("Authorization") == "Bearer " + TOKEN

    def do_POST(self):
        if not self.authorized():
            return self.reply(401, {"message": "unauthorized"})
        if self.path not in ("/price-explanations", "/jobs"):
            return self.reply(404, {"message": "not found"})
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        visitor = self.headers.get("X-Rag-Visitor", "")
        entry = {"path": self.path, "payload": body, "visitor": visitor, "polls": 0}
        posts.append(entry)
        ident = str(uuid.uuid4())
        jobs[ident] = entry
        self.reply(202, self.envelope(ident, entry))

    @staticmethod
    def envelope(ident, entry):
        envelope = {"job_id": ident, "status": "running"}
        if entry["path"] == "/price-explanations":
            context = entry["payload"]["context"]
            envelope["price_context"] = {key: context[key] for key in ("analysis_id", "revision")}
        return envelope

    def do_GET(self):
        ident = self.path.removeprefix("/jobs/")
        entry = jobs.get(ident)
        if not self.authorized() or not entry or self.headers.get("X-Rag-Visitor") != entry["visitor"]:
            return self.reply(404, {"message": "not found"})
        polls.append({"id": ident, "visitor": self.headers.get("X-Rag-Visitor")})
        entry["polls"] += 1
        envelope = self.envelope(ident, entry)
        question = entry["payload"]["question"]
        if "취소 확인" in question:
            return self.reply(200, envelope)
        if entry["path"] == "/price-explanations":
            context = entry["payload"]["context"]
            median = context["computed"]["benchmark"]["median"]
            rows = context["computed"]["rows"]
            calculation = f"모의 계약 응답: 외부 완성부품 견적 중앙값 {median:,.0f}원. " if median is not None else "외부 완성부품 시장 참고가격 계산 불가. "
            calculation += " / ".join(f"{row['supplierName']} {row['deltaPct']:.1f}%" if row["deltaPct"] is not None else f"{row['supplierName']} 비교 제외" for row in rows)
            explanation = "조건 문서에서 가격 차이의 원가 사유는 확인되지 않아 추가 확인이 필요합니다. [E1]"
            raw_record = context["supplier_quotes"][0] if context["supplier_quotes"] else None
            if not raw_record or median is None:
                result = {"status": "insufficient_evidence", "answer": "관련 근거를 찾지 못함. 조건을 확인해 주세요.", "sources": [], "model_called": False, "calculation_text": "시장 참고가격 계산 불가", "explanation": "관련 근거를 찾지 못함."}
            else:
                source = raw_record["source"]
                result = {"status": "answered", "answer": calculation + explanation, "sources": [{"evidence_id": "E1", "chunk_id": "price:" + source["documentId"], "parent_document_id": source["documentId"], "source": {"source_refs": ["price_document:" + source["documentId"] + "#p1"], "document_id": source["documentId"], "document_title": source["title"], "document_date": source["date"], "page": "1", "item_code": context["item"]["itemCode"], "supplier_ids": [raw_record["supplierId"]], "record_ids": [raw_record["id"]], **envelope["price_context"]}}], "model_called": True, "calculation_text": calculation, "explanation": explanation}
            result.update(price_context=envelope["price_context"])
        else:
            result = {"status": "insufficient_evidence", "answer": "모의 구매 DB: 질문 경로 확인만 수행했습니다.", "sources": [], "model_called": False}
        result.update(question=question, generation_model="qwen3:8b", retrieval_method="mock_contract_only")
        self.reply(200, {**envelope, "status": "succeeded", "result": result})


def free_port():
    with socket.socket() as connection:
        connection.bind(("127.0.0.1", 0))
        return connection.getsockname()[1]


def ask(page, text):
    if not page.locator("#chat-input").is_visible():
        page.locator(".chat-launcher").click()
    before = page.locator(".msg-ai").count()
    page.locator("#chat-input").fill(text)
    page.locator(".send-btn").click()
    page.wait_for_function("before => !document.querySelector('.progress') && document.querySelectorAll('.msg-ai').length > before", arg=before, timeout=20000)


def session(page):
    page.wait_for_timeout(200)
    return page.evaluate("() => {const k=Object.keys(localStorage).find(k=>k.endsWith(':session.v3'));return JSON.parse(localStorage[k]);}")


def current_result(page):
    saved = session(page)
    return saved["results"][saved["view"]["resultId"]]


def css_digest(value):
    return hashlib.sha256(value.replace(b"\r\n", b"\n")).hexdigest()


SHOTS.mkdir(parents=True, exist_ok=True)
baseline_css = subprocess.check_output(["git", "show", "5acd8c4:src/styles.css"], cwd=ROOT)
check("기존 디자인 CSS 원본 해시 유지", css_digest(baseline_css) == css_digest((ROOT / "src/styles.css").read_bytes()))
baseline = json.loads(subprocess.check_output(["node", "--import", "tsx", "--input-type=module", "-e", "import {loadSample} from './src/data/sampleData.ts';import {derive} from './src/lib/metrics.ts';const {data,meta}=loadSample();console.log(JSON.stringify([...derive(data,meta.asOf).evaluations].map(([id,e])=>[id,{total:e.total,grade:e.grade}])));"], cwd=ROOT))
baseline = dict(baseline)
gateway = ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
threading.Thread(target=gateway.serve_forever, daemon=True).start()
port = free_port()
url = f"http://127.0.0.1:{port}"
env = {**os.environ, "PORT": str(port), "RAG_ORIGIN": f"http://127.0.0.1:{gateway.server_port}", "RAG_GATEWAY_TOKEN": TOKEN, "ANTHROPIC_API_KEY": ""}
with tempfile.TemporaryFile() as log:
    server = subprocess.Popen(["node", "server/index.mjs"], cwd=ROOT, env=env, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    try:
        for attempt in range(100):
            try:
                with urlopen(url + "/api/rag/status", timeout=1) as response:
                    if json.load(response)["enabled"]:
                        break
            except OSError:
                if server.poll() is not None:
                    raise RuntimeError("테스트 웹 서버 종료")
                time.sleep(.05)
        else:
            raise RuntimeError("테스트 웹 서버 시작 시간 초과")
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page(viewport={"width": 1366, "height": 768})
            errors, network = [], []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("request", lambda request: network.append(request.url))
            indicators = [{"id": "mock-fx", "kind": "fx", "label": "USD/KRW 테스트 환율", "status": "example", "source": "로컬 테스트 모의 응답", "sourceUrl": None, "observedAt": "2026-10-15", "fetchedAt": "2026-10-26T00:00:00.000Z", "value": 1324.45, "unit": "KRW/USD", "currency": "KRW", "message": "E2E 모의 예시이며 실제 API 조회가 아닙니다.", "isSample": True}, {"id": "mock-material", "kind": "material", "label": "원자재 가격 API", "status": "not_configured", "source": "미연결", "sourceUrl": None, "observedAt": None, "fetchedAt": None, "value": None, "unit": "–", "currency": None, "message": "실제 API 미연결", "isSample": False}]
            page.route("**/api/market/indicators", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"indicators": indicators}, ensure_ascii=False)))
            page.goto(url, wait_until="domcontentloaded")
            page.locator("#login-demo").click()
            page.locator(".eval-card").wait_for()
            if page.locator("#ob-skip").count():
                page.locator("#ob-skip").click()
            original_card = page.locator(".eval-card").inner_text()
            page.locator(".chat-launcher").click()
            page.wait_for_function("() => document.querySelector('.rag-connection')?.textContent.includes('가격 비교는 현재 화면 기준')")
            ask(page, "ITM-1001 업체별 단가를 시장 참고가격과 비교해줘")
            expect(page.locator(".result-titles h3")).to_contain_text("시장 참고가격")
            first = current_result(page)
            price = first["priceAnalysis"]
            check("가격 질문은 전용 API와 현재 웹 품목 ID 사용", posts[-1]["path"] == "/price-explanations" and posts[-1]["payload"]["context"]["item"]["itemCode"] == "ITM-1001")
            check("3개 외부 완성부품 견적 중앙값 100만원", price["benchmark"]["median"] == 1000000 and price["benchmark"]["count"] == 3)
            check("A+12 B+5 C-2 D검사불일치 제외", [row["deltaPct"] for row in price["rows"]] == [12, 5, -2, None] and price["rows"][3]["status"] == "excluded")
            check("제외 행 차액·차이율은 null", first["rows"][3]["values"]["delta"] is None and first["rows"][3]["values"]["deltaPct"] is None)
            expect(page.locator(".chat-list")).to_contain_text("1,000,000원")
            expect(page.locator(".result-table tbody tr").filter(has_text="업체 D")).to_contain_text("비교 제외")
            check("가격 API 폴링 소유자는 POST와 같음", all(poll["visitor"] == jobs[poll["id"]]["visitor"] for poll in polls) and len(posts[-1]["visitor"]) == 43)
            check("기존 네 가지 결과 형식 유지", page.locator(".tpl-btn").count() == 4 and all(page.locator(f"[data-template='{kind}']").is_enabled() for kind in ["table", "chart", "cards", "report"]))
            for kind in ["table", "chart", "cards", "report"]:
                page.locator(f"[data-template='{kind}']").click()
                expect(page.locator("[data-market-reference]")).to_contain_text("1,000,000원")
                page.screenshot(path=str(SHOTS / f"price_{kind}_1366.png"))
            page.locator("[data-template='table']").click()
            api = page.locator("details").filter(has=page.locator("summary", has_text="외부 API 참고 정보")).last
            api.locator("summary").click()
            expect(page.locator("[data-indicator-id='mock-fx']")).to_contain_text("API 예시 데이터")
            expect(page.locator("[data-indicator-id='mock-fx']")).to_contain_text("1,324.45")
            expect(page.locator("[data-indicator-id='mock-material']")).to_contain_text("API 미연결")
            check("API 출처·관측일·조회시각을 명시하고 완성부품 가격과 구별", "로컬 테스트 모의 응답" in api.inner_text() and "2026-10-15" in api.inner_text() and "2026-10-26T00:00:00.000Z" in api.inner_text() and "보정값으로 대체하지 않습니다" in api.inner_text())
            page.locator("[data-external-quotes] > summary").click()
            quote = page.locator("[data-external-quote-id='EXT-LINER-002']")
            quote.fill("1040000")
            quote.press("Enter")
            expect(page.locator("[data-market-reference]")).to_contain_text("1,020,000원")
            updated = current_result(page)
            check("외부 견적 수정시 같은 결과 ID·생성시각을 유지하고 버전 변경", updated["id"] == first["id"] and updated["createdAt"] == first["createdAt"] and updated["priceAnalysis"]["revision"] != price["revision"])
            check("외부 견적2 104만원 → 중앙값102만원·A차액10만원", updated["priceAnalysis"]["benchmark"]["median"] == 1020000 and updated["rows"][0]["values"]["delta"] == 100000)
            expect(page.locator(".chat-list")).to_contain_text("이전 가격 비교 조건으로 만든 답변")
            check("이전 채팅 설명에 현재 가격과 다를 수 있다는 경고", "현재 표와 다를 수 있습니다" in page.locator(".chat-list").inner_text())
            for row in updated["rows"]:
                check(f"{row['supplierId']} 기존 평가점수·등급 불변", row["values"]["total"] == baseline[row["supplierId"]]["total"] and row["values"]["grade"] == baseline[row["supplierId"]]["grade"])
            check("기존 평가 카드 원본 유지", page.locator(".eval-card").inner_text() == original_card)
            for kind in ["table", "chart", "cards", "report"]:
                page.locator(f"[data-template='{kind}']").click()
                expect(page.locator("[data-market-reference]")).to_contain_text("1,020,000원")
                if kind == "chart":
                    page.locator(".chart-table > summary").click()
                    expect(page.locator(".chart-table")).to_contain_text("1,020,000")
                    check("가격 차트는 비교가능 3개 업체만 표시", "업체 D" not in page.locator(".chart-table").inner_text())
                if kind == "report":
                    expect(page.locator("table[aria-label='보고서 협력사 가격 비교']")).to_contain_text("1,020,000원")
                page.screenshot(path=str(SHOTS / f"price_updated_{kind}_1366.png"))
            ask(page, "A업체는 왜 높은지 근거 알려줘")
            check("후속 질문도 현재 수정된 품목·가격 문맥 사용", posts[-1]["path"] == "/price-explanations" and posts[-1]["payload"]["context"]["computed"]["benchmark"]["median"] == 1020000 and posts[-1]["payload"]["context"]["item"]["itemCode"] == "ITM-1001")
            expect(page.locator(".msg-ai").last).to_contain_text("1,020,000원")
            ask(page, "ITM-1001 업체 A만 시장 참고가격과 비교해줘")
            check("업체 A만 요청하면 현재 표와 RAG 문맥 모두 A 한 곳", posts[-1]["payload"]["context"]["supplier_ids"] == ["SUP-001"] and len(current_result(page)["priceAnalysis"]["rows"]) == 1)
            ask(page, "왜 높은지 근거 알려줘")
            check("단순 후속 설명에서 좁힌 협력사 범위를 유지", posts[-1]["payload"]["context"]["supplier_ids"] == ["SUP-001"] and len(current_result(page)["priceAnalysis"]["rows"]) == 1)
            ask(page, "ITM-1001 업체별 단가를 시장 참고가격과 비교해줘")
            check("명시적인 전체 비교 요청은 협력사 범위를 다시 넓힘", len(posts[-1]["payload"]["context"]["supplier_ids"]) == 4 and len(current_result(page)["priceAnalysis"]["rows"]) == 4)
            # 새로 선택한 품목을 사용하는 일반 가격 질문은 이전 가격 화면에 묶이지 않는다.
            page.locator("#tab-inventory").click()
            page.locator(".data-table tbody tr").filter(has_text="ITM-1002").click()
            ask(page, "선택한 품목 시장 참고가격과 비교해줘")
            check("선택 품목 변경 후 새 가격 문맥에 ITM-1002 전달", posts[-1]["path"] == "/price-explanations" and posts[-1]["payload"]["context"]["item"]["itemCode"] == "ITM-1002")
            ask(page, "국제 니켈 시장가격 최근 6개월")
            check("기존 원자재 질문은 일반 RAG 경로 유지", posts[-1]["path"] == "/jobs" and "context" not in posts[-1]["payload"])
            expect(page.locator(".panel-c .topic .chart-title")).to_contain_text("니켈 국제 시세 추이")
            expect(page.locator(".panel-c .topic .chart-title")).to_contain_text("최근 6개월")
            ask(page, "ITM-1001 시장 참고가격 비교해줘")
            page.locator("[data-template='report']").click()
            page.locator(".chat-tools [aria-label='닫기']").click()
            for width, height in [(1920, 1080), (1366, 768), (900, 900), (400, 860)]:
                page.set_viewport_size({"width": width, "height": height})
                page.wait_for_timeout(100)
                if width <= 1180:
                    page.get_by_role("button", name="분석 결과", exact=True).click()
                check(f"{width}px 페이지 가로 넘침 없음", page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
                small = page.evaluate("() => [...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width && r.height && [...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()) && parseFloat(getComputedStyle(e).fontSize)<12}).length")
                check(f"{width}px 표시 텍스트 12px 이상", small == 0)
                page.screenshot(path=str(SHOTS / f"price_final_{width}.png"))
            external = [request for request in network if not request.startswith(url) and not request.startswith("data:")]
            check("클라이언트 외부 API·모델 직접 호출 없음", all(request.startswith("https://fonts.googleapis.com/") or request.startswith("https://fonts.gstatic.com/") for request in external))
            check("비밀 토큰은 DOM과 localStorage에 없음", TOKEN not in page.content() and TOKEN not in json.dumps(session(page), ensure_ascii=False))
            # 이전 결과는 읽을 수 있지만 새 업로드의 견적 편집기로 사용해서는 안 된다.
            page.set_viewport_size({"width": 1366, "height": 768})
            page.locator("[data-template='table']").click()
            csv = "업체ID,협력사명,품질 평가 점수,불량률(%),기술·대응력 점수,경영·ESG 점수\nSUP-011,가격 회귀 업로드 K,60,4.5,50,40\n"
            page.locator(".topbar .btn-primary").click()
            page.select_option("#import-dataset", "suppliers")
            page.set_input_files("#import-file", {"name": "price-stale-upload.csv", "mimeType": "text/csv", "buffer": csv.encode("utf8")})
            page.locator(".validation").wait_for()
            page.locator(".modal-foot .btn-primary").click()
            expect(page.locator(".stale")).to_be_visible()
            for kind in ["table", "chart", "cards", "report"]:
                page.locator(f"[data-template='{kind}']").click()
                expect(page.locator("[data-market-reference]")).to_contain_text("1,020,000원")
                check(f"업로드 후 이전 {kind} 결과의 견적 입력은 읽기 전용", page.locator("[data-external-quote-id]").count() == 0)
            check("업로드 후 이전 가격 결과를 열어도 앱 유지", page.locator(".eval-card").count() == 1 and not errors)
            page.screenshot(path=str(SHOTS / "price_stale_upload_1366.png"))
            # sample의 dataId가 같아도 가격 입력 revision은 초기화되므로 오래된 가격 표임을 표시해야 한다.
            page.locator(".topbar .sample-reset").click()
            page.locator("[role=alertdialog] [data-confirm]").click()
            expect(page.locator(".badge-demo")).to_have_text("SAMPLE")
            expect(page.locator(".stale")).to_be_visible()
            expect(page.locator("[data-market-reference]")).to_contain_text("1,020,000원")
            check("샘플 복원 후 이전 가격 revision은 경고와 읽기 전용 유지", page.locator("[data-external-quote-id]").count() == 0)
            page.locator(".stale button").click()
            expect(page.locator(".stale")).to_have_count(0)
            expect(page.locator("[data-market-reference]")).to_contain_text("1,000,000원")
            check("다시 분석하면 초기화된 실제 가격 입력과 편집기가 동기화", page.locator("[data-external-quote-id]").count() == 3 and current_result(page)["priceAnalysis"]["benchmark"]["median"] == 1000000)
            page.screenshot(path=str(SHOTS / "price_reset_reanalyzed_1366.png"))
            check("브라우저 JavaScript 오류 없음", not errors)
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)
        gateway.shutdown()
        gateway.server_close()
        if sys.exc_info()[0]:
            log.seek(0)
            print(log.read().decode("utf8", errors="replace")[-4000:], flush=True)
print(f"Price E2E: {len(checks)} checks passed; screenshots: {SHOTS}", flush=True)
