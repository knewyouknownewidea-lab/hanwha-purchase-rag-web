"""실제 업로드 UI·Node 중계와 모의 게이트웨이로 웹 데이터 RAG 수명주기를 검증한다.

실제 모델 검증은 별도로 수행한다. python tests/web-rag-e2e.py [캡처 폴더]

v0.6.0: 챗봇의 질문 방식 선택(#chat-answer-mode)이 사용자 요청으로 삭제되어 이 화면 테스트는 실행할 수 없다.
웹 데이터 RAG 코드·서버 API는 남아 있고 서버·클라이언트 단위 검사(npm run test:rag)로 계속 확인한다.
화면에서 다시 쓰게 되면 이 테스트를 새 진입점에 맞춰 고친다.
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
SHOTS = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix='web-rag-e2e-'))
TOKEN = 'web-rag-test-only-0123456789abcdef0123456789'
datasets, jobs, submissions, deleted, checks = {}, {}, [], [], []
slow_create = threading.Event()


def check(name, condition):
    checks.append((name, bool(condition)))
    print(('PASS ' if condition else 'FAIL ') + name, flush=True)
    if not condition:
        raise AssertionError(name)


class Gateway(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body):
        content = json.dumps(body, ensure_ascii=False).encode('utf8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        try:
            self.wfile.write(content)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def authorized(self):
        return self.headers.get('Authorization') == 'Bearer ' + TOKEN

    def dataset(self, ident):
        value = datasets.get(ident)
        return value if value and not value['deleted'] and value['visitor'] == self.headers.get('X-Rag-Visitor') else None

    def do_POST(self):
        if not self.authorized():
            return self.reply(401, {'message': 'unauthorized'})
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
        if self.path == '/datasets':
            ident = str(uuid.uuid4())
            revision = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
            item = {'body': body, 'visitor': self.headers.get('X-Rag-Visitor'), 'deleted': False, 'polls': 0,
                    'public': {'dataset_id': ident, 'revision': revision, 'status': 'indexing',
                               'row_count': sum(len(rows) for rows in body['data'].values()), 'chunk_count': 1}}
            datasets[ident] = item
            if 'slow-create.csv' in body['meta']['sources'].values():
                slow_create.set()
                time.sleep(2)
            return self.reply(202, item['public'])
        if self.path != '/jobs':
            return self.reply(404, {'message': 'not found'})
        dataset = body.get('dataset')
        item = self.dataset(dataset['id']) if dataset else None
        if not item or dataset['revision'] != item['public']['revision']:
            return self.reply(404, {'message': 'not found'})
        ident = str(uuid.uuid4())
        jobs[ident] = {'payload': body, 'visitor': self.headers.get('X-Rag-Visitor'), 'polls': 0}
        submissions.append(jobs[ident])
        self.reply(202, {'job_id': ident, 'status': 'running', 'dataset': dataset})

    def do_GET(self):
        if not self.authorized():
            return self.reply(401, {'message': 'unauthorized'})
        if self.path.startswith('/datasets/'):
            item = self.dataset(self.path.rsplit('/', 1)[1])
            if not item:
                return self.reply(404, {'message': 'not found'})
            item['polls'] += 1
            value = {**item['public'], 'status': 'ready' if item['polls'] >= 2 else 'indexing'}
            return self.reply(200, value)
        ident = self.path.removeprefix('/jobs/')
        job = jobs.get(ident)
        if not job or job['visitor'] != self.headers.get('X-Rag-Visitor'):
            return self.reply(404, {'message': 'not found'})
        body = job['payload']
        dataset = body['dataset']
        item = self.dataset(dataset['id'])
        if not item:
            return self.reply(404, {'message': 'not found'})
        job['polls'] += 1
        if job['polls'] == 1 or body['question'] == '늦은 답변 확인':
            return self.reply(200, {'job_id': ident, 'status': 'running', 'dataset': dataset})
        row = next((row for row in item['body']['data']['purchaseOrders'] if row['poNo'] == 'PO-UP-RAG'), None)
        result = {'question': body['question'], 'generation_model': body['model'], 'dataset': dataset,
                  'status': 'answered' if row else 'insufficient_evidence', 'model_called': bool(row),
                  'answer': f"업로드 발주 PO-UP-RAG 수량은 {row['qty']}입니다. [E1]" if row else '제공된 문서에서 관련 정보를 찾을 수 없습니다.',
                  'retrieval_method': 'web_snapshot', 'citation_check': 'valid_ids_only' if row else 'not_applicable',
                  'sources': [{'evidence_id': 'E1', 'parent_document_id': 'web:purchaseOrders:PO-UP-RAG',
                               'source': {'source_refs': ['web:purchaseOrders:PO-UP-RAG'], 'source_db': '웹 화면 데이터',
                                          'dataset_key': 'purchaseOrders', 'record_key': 'PO-UP-RAG',
                                          'dataset_id': dataset['id'], 'revision': dataset['revision'], 'source_file': item['body']['meta']['sources']['purchaseOrders'],
                                          'data_label': 'SAMPLE + 업로드 데이터'}}] if row else []}
        self.reply(200, {'job_id': ident, 'status': 'succeeded', 'dataset': dataset, 'result': result})

    def do_DELETE(self):
        item = self.dataset(self.path.removeprefix('/datasets/'))
        if not self.authorized() or not item:
            return self.reply(404, {'message': 'not found'})
        item['deleted'] = True
        deleted.append(item['public']['dataset_id'])
        self.reply(200, {'deleted': True})


def free_port():
    with socket.socket() as connection:
        connection.bind(('127.0.0.1', 0))
        return connection.getsockname()[1]


def logged_in(page):
    page.locator('.eval-card').wait_for()
    if page.locator('#ob-skip').count():
        page.locator('#ob-skip').click()


def open_chat(page):
    if not page.locator('#chat-input').is_visible():
        page.locator('.chat-launcher').click()
    page.locator('#chat-answer-mode').select_option('web-rag')
    expect(page.locator('#rag-model')).to_be_enabled()
    page.locator('#rag-model').select_option('qwen3:8b')


def upload(page, name, rows, csv=False, mode='merge'):
    page.locator('.topbar .btn-primary').click()
    page.locator('#import-dataset').select_option('purchaseOrders')
    if csv:
        content = ('발주번호,품목코드,업체ID,발주 수량,발주 일자,납기 예정일\n' +
                   '\n'.join(','.join(str(row[key]) for key in ['poNo', 'itemCode', 'supplierId', 'qty', 'orderDate', 'dueDate']) for row in rows))
    else:
        content = json.dumps(rows, ensure_ascii=False)
    page.locator('#import-file').set_input_files({'name': name, 'mimeType': 'text/csv' if csv else 'application/json', 'buffer': content.encode('utf8')})
    expect(page.locator('.validation-stats')).to_contain_text('반영 가능')
    page.locator('#mode-' + mode).check()
    page.locator('.modal-foot .btn-primary').click()
    page.locator('#import-title').wait_for(state='detached')


def ask(page, text):
    before = page.locator('.msg-ai').count()
    page.locator('#chat-input').fill(text)
    page.locator('.send-btn').click()
    page.wait_for_function('before => !document.querySelector(".progress") && document.querySelectorAll(".msg-ai").length > before', arg=before, timeout=25000)


def logout(page):
    page.locator('.user-btn').click()
    page.locator('.user-pop .menu-item', has_text='로그아웃').click()
    page.locator('[role="alertdialog"] [data-confirm]').click()
    page.locator('#login-name').wait_for()


def reset(page):
    page.locator('.sample-reset').click()
    page.locator('[role="alertdialog"] [data-confirm]').click()
    expect(page.locator('.badge-demo')).to_have_text('SAMPLE')


SHOTS.mkdir(parents=True, exist_ok=True)
gateway = ThreadingHTTPServer(('127.0.0.1', 0), Gateway)
threading.Thread(target=gateway.serve_forever, daemon=True).start()
port = free_port()
url = f'http://127.0.0.1:{port}'
env = {**os.environ, 'PORT': str(port), 'RAG_ORIGIN': f'http://127.0.0.1:{gateway.server_port}',
       'RAG_GATEWAY_TOKEN': TOKEN, 'ANTHROPIC_API_KEY': ''}
row = {'poNo': 'PO-UP-RAG', 'itemCode': 'ITM-1001', 'supplierId': 'SUP-001', 'qty': 731,
       'orderDate': '2026-10-25', 'dueDate': '2026-11-10', 'currency': 'KRW'}
with tempfile.TemporaryFile() as log:
    server = subprocess.Popen(['node', 'server/index.mjs'], cwd=ROOT, env=env, stdout=log, stderr=log,
                              creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    try:
        for _ in range(100):
            try:
                with urlopen(url + '/api/rag/status', timeout=1) as response:
                    if json.load(response)['enabled']:
                        break
            except OSError:
                if server.poll() is not None:
                    raise RuntimeError('web server exited')
                time.sleep(.05)
        else:
            raise RuntimeError('web server timeout')
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            context = browser.new_context(viewport={'width': 1366, 'height': 900})
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(url)
            page.locator('#login-name').fill('업로드 검증 A')
            page.locator('#login-submit').click()
            logged_in(page)
            upload(page, '가상발주.csv', [row], csv=True)
            check('실제 CSV 불러오기·검증·병합 UI 사용', page.locator('.badge-demo').inner_text() == '업로드 포함')
            open_chat(page)
            ask(page, 'PO-UP-RAG 발주 수량은?')
            expect(page.locator('.chat-list')).to_contain_text('731')
            first = submissions[-1]
            first_id = first['payload']['dataset']['id']
            snapshot = datasets[first_id]['body']
            check('현재 11종 표를 하나의 스냅샷으로 전달', len(snapshot['data']) == 11)
            check('샘플이 남는 병합 상태를 명시', snapshot['meta']['isSample'] is False and 'SAMPLE' in snapshot['meta']['label'])
            check('업로드 발주 문자열 키 보존', any(r['poNo'] == 'PO-UP-RAG' and r['qty'] == 731 for r in snapshot['data']['purchaseOrders']))
            check('구매 DB 숫자 필터로 변환하지 않음', not any(k in first['payload'] for k in ['order_id', 'supplier_id', 'part_id']))
            check('실제 중계는 세션별 43자 방문자 사용', len(first['visitor']) == 43)
            page.locator('.rag-sources summary').last.click()
            expect(page.locator('.rag-sources').last).to_contain_text('PO-UP-RAG')
            check('업로드 출처·데이터 버전 표시', first['payload']['dataset']['revision'][:8] in page.locator('.rag-sources').last.inner_text())
            check('파일명을 출처로 표시', '가상발주.csv' in page.locator('.rag-sources').last.inner_text())
            upload(page, '발주수정.json', [{**row, 'qty': 842}])
            ask(page, 'PO-UP-RAG 발주 수량은?')
            expect(page.locator('.msg-ai').last).to_contain_text('842')
            second_id = submissions[-1]['payload']['dataset']['id']
            check('업로드 수정 후 새 버전으로 검색', second_id != first_id)
            check('이전 스냅샷 삭제', first_id in deleted)
            check('새 답변에 이전 수량이 섞이지 않음', '731' not in page.locator('.msg-ai').last.inner_text())
            page.reload()
            logged_in(page)
            check('페이지 새로고침 시 이전 서버 스냅샷 정리', second_id in deleted)
            open_chat(page)
            ask(page, 'PO-UP-RAG 발주 수량은?')
            expect(page.locator('.msg-ai').last).to_contain_text('842')
            check('새로고침 후 IndexedDB 업로드로 새 세션 검색', submissions[-1]['visitor'] != first['visitor'])
            restore_id = submissions[-1]['payload']['dataset']['id']
            # 진행 중 작업을 남긴 채 원본 데이터를 없애면 폴링·결과가 계속 표시되지 않아야 한다.
            page.locator('#chat-input').fill('늦은 답변 확인')
            page.locator('.send-btn').click()
            page.locator('.progress').wait_for()
            reset(page)
            page.locator('.progress').wait_for(state='detached')
            page.wait_for_timeout(500)
            check('샘플 복귀가 실행 중 검색 스냅샷을 폐기', restore_id in deleted)
            check('데이터 변경 후 전송 잠금 해제', page.locator('#chat-answer-mode').is_enabled())
            ask(page, 'PO-UP-RAG 발주 수량은?')
            expect(page.locator('.msg-ai').last).to_contain_text('관련 정보를 찾을 수 없습니다')
            check('삭제된 업로드 사실을 다음 답변에서 사용하지 않음', '842' not in page.locator('.msg-ai').last.inner_text())
            last_owner = submissions[-1]['visitor']
            last_id = submissions[-1]['payload']['dataset']['id']
            logout(page)
            page.wait_for_timeout(400)
            check('로그아웃 시 서버 임시 스냅샷 삭제', last_id in deleted)
            page.locator('#login-name').fill('업로드 검증 B')
            page.locator('#login-submit').click()
            logged_in(page)
            upload(page, '다른사용자.json', [{**row, 'qty': 913}], mode='replace')
            open_chat(page)
            ask(page, 'PO-UP-RAG 발주 수량은?')
            expect(page.locator('.msg-ai').last).to_contain_text('913')
            check('같은 브라우저의 다른 로그인도 서버 세션 분리', submissions[-1]['visitor'] != last_owner)
            check('교체 업로드에는 해당 표의 새 행만 포함', len(datasets[submissions[-1]['payload']['dataset']['id']]['body']['data']['purchaseOrders']) == 1)
            for width, height in [(1920, 1080), (1366, 900), (900, 1000), (400, 860)]:
                page.set_viewport_size({'width': width, 'height': height})
                expect(page.locator('#chat-answer-mode')).to_be_visible()
                check(f'{width}px: 업로드 RAG 조작 가능·가로 넘침 없음', page.evaluate('document.documentElement.scrollWidth <= innerWidth') and page.locator('#rag-model').is_visible())
                too_small = page.locator('#chat-window').evaluate('''root => [...root.querySelectorAll('*')].filter(e => {
                    const r=e.getBoundingClientRect(); return r.width && r.height && [...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()) && parseFloat(getComputedStyle(e).fontSize)<12;
                }).length''')
                check(f'{width}px: 챗봇 글자 12px 이상', too_small == 0)
                page.screenshot(path=str(SHOTS / f'web_rag_{width}.png'))
            page.set_viewport_size({'width': 1366, 'height': 900})
            upload(page, 'slow-create.csv', [{**row, 'qty': 999}], csv=True)
            page.locator('#chat-input').fill('등록 취소 확인')
            page.locator('.send-btn').click()
            for _ in range(50):
                if slow_create.is_set():
                    break
                page.wait_for_timeout(50)
            check('늦은 등록 응답 테스트가 실제 등록 요청을 시작', slow_create.is_set())
            reset(page)
            page.wait_for_timeout(2600)
            late = [item for item in datasets.values() if 'slow-create.csv' in item['body']['meta']['sources'].values()]
            check('취소 후 늦게 도착한 데이터 ID도 정리', len(late) == 1 and late[0]['deleted'])
            check('등록 취소 뒤 이전 사실 답변 없음', '999' not in page.locator('.chat-list').inner_text())
            check('브라우저 JavaScript 오류 없음', not errors)
            check('내부 토큰이 HTML에 노출되지 않음', TOKEN not in page.content())
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()
        gateway.shutdown()
        gateway.server_close()

print(f'\n{sum(ok for _, ok in checks)}/{len(checks)} 웹 업로드 RAG E2E 통과 · 모의 게이트웨이', flush=True)
