// 외부 모델 없이 현재 가격 문맥·세션·취소·기존 질문 경로를 검증합니다.
import assert from "node:assert/strict";
import test from "node:test";
import { askPriceExplanation } from "../src/ai/priceRag";
import { priceQuestion } from "../src/ai/priceIntent";
import { RagHttpError } from "../src/ai/rag";
import { detectMarketTopic } from "../src/ai/topic";
import { answer } from "../src/ai/agent";
import { loadSample } from "../src/data/sampleData";
import { createPriceSample } from "../src/data/priceSample";
import { buildPriceAnalysis, priceContextForRag, updateExternalQuote, type PriceAnalysis } from "../src/lib/priceComparison";
import { derive } from "../src/lib/metrics";

const jobId = "11111111-1111-4111-8111-111111111111";
const session = "s".repeat(43);
const question = "A업체는 왜 시장 참고가격보다 12% 높은가요?";
const sample = loadSample();
const inputs = createPriceSample(sample.data, sample.meta);
const analysis = buildPriceAnalysis(sample.data, sample.meta, inputs, { itemCode: "ITM-1001" });
const contextId = (context = analysis) => ({ analysis_id: context.id, revision: context.revision });
const running = (context = analysis) => ({ job_id: jobId, status: "running", price_context: contextId(context) });
const result = (context = analysis) => ({
  question, status: "answered", answer: "협력사 단가 1,120,000원, 외부 견적 중앙값 1,000,000원, 차이율 +12%입니다. 문서로 확인되지 않은 차이 사유는 추가 확인이 필요합니다. [E1]",
  generation_model: "qwen3:8b", model_called: true, price_context: contextId(context),
  sources: [{ evidence_id: "E1", chunk_id: "price:PRICE-INT-A", parent_document_id: "PRICE-INT-A", similarity: 0.8,
    source: { source_refs: ["price_document:PRICE-INT-A#p1"], document_id: "PRICE-INT-A", document_title: "가상 신규 협력사 견적 A 조건서", document_date: "2026-10-15", page: "1", item_code: "ITM-1001", supplier_ids: ["SUP-001"], record_ids: ["INT-LINER-A"], ...contextId(context) } }],
});
const succeeded = (context = analysis) => ({ ...running(context), status: "succeeded", result: result(context) });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sequence = (...steps: (unknown | Response)[]) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    assert.ok(steps.length, "unexpected extra network request");
    const next = steps.shift();
    return next instanceof Response ? next : reply(next);
  };
  return { calls, fetcher };
};
const ask = (fetcher: typeof fetch, context: PriceAnalysis = analysis, extra: { signal?: AbortSignal; pollIntervalMs?: number; timeoutMs?: number } = {}) => askPriceExplanation(question, context, { session, fetcher, pollIntervalMs: 0, ...extra });
const selected = { itemCode: "ITM-1001", supplierId: "SUP-001" };

test("price question submits current raw/computed context once and retains session through polling", async () => {
  const mock = sequence(running(), running(), succeeded());
  const response = await ask(mock.fetcher);
  assert.equal(response.answer, result().answer);
  assert.equal(response.model, "qwen3:8b");
  assert.deepEqual(response.sources, result().sources);
  assert.equal(mock.calls.length, 3);
  assert.equal(mock.calls.filter((call) => call.init?.method === "POST").length, 1);
  assert.equal(mock.calls[0].url, "/api/rag/price-explanations");
  assert.equal(mock.calls[1].url, `/api/rag/jobs/${jobId}`);
  assert.equal(mock.calls[2].url, mock.calls[1].url);
  const body = JSON.parse(String(mock.calls[0].init?.body));
  assert.deepEqual(body, { question, model: "qwen3:8b", context: priceContextForRag(analysis) });
  assert.equal(body.context.computed.benchmark.median, 1000000);
  assert.equal(body.context.computed.rows[0].deltaPct, 12);
  assert.equal(body.context.computed.rows[3].deltaPct, null);
  for (const call of mock.calls) {
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get("X-Rag-Session"), session);
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.has("authorization"), false);
    assert.equal(headers.has("X-Rag-Visitor"), false);
    assert.equal(call.init?.credentials, "same-origin");
  }
  assert.equal("session" in body, false);
  assert.equal("owner" in body, false);
});

test("edited external quote context is submitted with new revision and recalculated values", async () => {
  const nextInputs = updateExternalQuote(inputs, "EXT-LINER-002", 1040000);
  const context = buildPriceAnalysis(sample.data, sample.meta, nextInputs, { itemCode: "ITM-1001" });
  const mock = sequence(succeeded(context));
  await ask(mock.fetcher, context);
  const body = JSON.parse(String(mock.calls[0].init?.body));
  assert.equal(body.context.revision, nextInputs.revision);
  assert.equal(body.context.external_quotes[1].unitPrice, 1040000);
  assert.equal(body.context.computed.benchmark.median, 1020000);
  assert.equal(body.context.computed.rows[0].delta, 100000);
});

test("job analysis ID or revision mismatch is rejected before polling", async () => {
  for (const price_context of [{ ...contextId(), analysis_id: "price-another-view" }, { ...contextId(), revision: "older-revision" }, null, undefined]) {
    const mock = sequence({ ...running(), price_context });
    await assert.rejects(ask(mock.fetcher), /응답 형식/);
    assert.equal(mock.calls.length, 1);
  }
});

test("same job ID with a different context in later polling is rejected", async () => {
  for (const changed of [{ analysis_id: "price-other", revision: analysis.revision }, { analysis_id: analysis.id, revision: "old" }]) {
    const mock = sequence(running(), { ...succeeded(), price_context: changed });
    await assert.rejects(ask(mock.fetcher), /응답 형식/);
    assert.equal(mock.calls.length, 2);
  }
});

test("successful result must echo the same context separately from the job envelope", async () => {
  for (const price_context of [{ ...contextId(), revision: "old" }, { ...contextId(), analysis_id: "price-other" }, undefined]) {
    const mock = sequence({ ...succeeded(), result: { ...result(), price_context } });
    await assert.rejects(ask(mock.fetcher), /응답 형식/);
  }
});

test("document source carrying an old analysis or revision is rejected", async () => {
  for (const changed of [{ analysis_id: "price-other" }, { revision: "old" }]) {
    const raw = result();
    Object.assign(raw.sources[0].source, changed);
    const mock = sequence({ ...succeeded(), result: raw });
    await assert.rejects(ask(mock.fetcher), /응답 형식/);
  }
});

test("source item and price record must belong to the displayed comparison", async () => {
  for (const changed of [{ item_code: "ITM-1002" }, { record_ids: ["INT-OTHER-A"] }, { record_ids: [] }]) {
    const raw = result();
    Object.assign(raw.sources[0].source, changed);
    const mock = sequence({ ...succeeded(), result: raw });
    await assert.rejects(ask(mock.fetcher), /응답 형식/);
  }
});

test("malformed job IDs and a different job response cannot change polling scope", async () => {
  for (const id of ["../private", "https://other.example/job", "", null]) {
    const mock = sequence({ ...running(), job_id: id });
    await assert.rejects(ask(mock.fetcher), /응답 형식/);
    assert.equal(mock.calls.length, 1);
  }
  const mock = sequence(running(), { ...succeeded(), job_id: "22222222-2222-4222-8222-222222222222" });
  await assert.rejects(ask(mock.fetcher), /응답 형식/);
});

test("unknown status and non-qwen generation cannot be displayed as price explanations", async () => {
  for (const invalid of [{ ...running(), status: "pending" }, { ...succeeded(), result: { ...result(), generation_model: "gemma3:4b" } }, { ...succeeded(), result: { ...result(), answer: "근거 없음", sources: [] } }]) {
    const mock = sequence(invalid);
    await assert.rejects(ask(mock.fetcher), /응답 형식/);
  }
});

test("insufficient evidence remains explicit without invented source or model call", async () => {
  const raw = { ...result(), status: "insufficient_evidence", answer: "관련 근거를 찾지 못함. 현재 계산값만 확인하고 차이 사유는 추가 확인해 주세요.", sources: [], model_called: false };
  const mock = sequence({ ...succeeded(), result: raw });
  const response = await ask(mock.fetcher);
  assert.equal(response.status, "insufficient_evidence");
  assert.equal(response.modelCalled, false);
  assert.deepEqual(response.sources, []);
});

test("failed job and HTTP quota errors retain safe status and are never resubmitted", async () => {
  const failed = sequence(running(), { ...running(), status: "failed", error_status: 409, message: "가격 조건이 변경되었습니다." });
  await assert.rejects(ask(failed.fetcher), (error: unknown) => error instanceof RagHttpError && error.status === 409 && error.message.includes("변경"));
  assert.equal(failed.calls.length, 2);
  const quota = sequence(reply({ message: "잠시 후 다시 시도해 주세요." }, 429));
  await assert.rejects(ask(quota.fetcher), (error: unknown) => error instanceof RagHttpError && error.status === 429);
  assert.equal(quota.calls.length, 1);
});

test("invalid question and already aborted request cannot create a job", async () => {
  for (const q of [" ", "가".repeat(1001)]) {
    const mock = sequence();
    await assert.rejects(askPriceExplanation(q, analysis, { session, fetcher: mock.fetcher }), /1~1000자/);
    assert.equal(mock.calls.length, 0);
  }
  const mock = sequence();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(ask(mock.fetcher, analysis, { signal: controller.signal }), /abort/i);
  assert.equal(mock.calls.length, 0);
});

test("selection/logout abort stops waiting before another poll", async () => {
  const mock = sequence(running());
  const controller = new AbortController();
  const pending = ask(mock.fetcher, analysis, { signal: controller.signal, pollIntervalMs: 1000 });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].init?.signal?.aborted, true);
});

test("abort cancels a stalled network request and timeout cancels the complete explanation", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => { init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }); });
  };
  const controller = new AbortController();
  const pending = ask(fetcher, analysis, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /abort/i);
  assert.equal(calls, 1);
  await assert.rejects(ask(fetcher, analysis, { timeoutMs: 5 }), /대기 시간이 초과/);
  assert.equal(calls, 2);
});

test("HTML and network failure are surfaced without fabricating another analysis", async () => {
  const mock = sequence(new Response("<html>offline</html>", { status: 200 }));
  await assert.rejects(ask(mock.fetcher), /응답 형식/);
  assert.equal(mock.calls.length, 1);
  await assert.rejects(ask(async () => { throw new TypeError("Failed to fetch"); }), /연결할 수 없습니다/);
});

test("explicit item overrides selection and current analysis, while bare comparison uses selected item", () => {
  assert.equal(priceQuestion("시장 참고가격과 비교해줘", sample.data, selected, analysis)?.itemCode, "ITM-1001");
  assert.equal(priceQuestion("ITM-1002 시장 참고가격과 비교해줘", sample.data, selected, analysis)?.itemCode, "ITM-1002");
  assert.equal(priceQuestion("시장 참고가격과 비교해줘", sample.data, { ...selected, itemCode: "ITM-1003" }, analysis)?.itemCode, "ITM-1003");
  assert.equal(priceQuestion("시장 참고가격과 비교해줘", sample.data, { itemCode: null, supplierId: null }, analysis)?.itemCode, "ITM-1001");
});

test("missing and ambiguous item are clarified rather than using guessed item", () => {
  const absent = priceQuestion("시장 참고가격과 비교해줘", sample.data, { itemCode: null, supplierId: null });
  assert.equal(absent?.itemCode, null);
  assert.match(absent!.reason!, /품목/);
  assert.equal(priceQuestion("ITM-1001과 ITM-1002 시장 참고가격 비교", sample.data, selected, analysis)?.itemCode, null);
  assert.equal(priceQuestion("시장 참고가격 비교", sample.data, { ...selected, itemCode: "ITM-9999" })?.itemCode, null);
});

test("unknown explicit item must not silently fall back to a selected item", () => {
  const unresolved = priceQuestion("ITM-9999 시장 참고가격 비교", sample.data, selected, analysis);
  assert.equal(unresolved?.itemCode, null);
  assert.match(unresolved!.reason!, /품목/);
});

test("follow-up explanation uses current price context but unrelated question stays outside it", () => {
  for (const q of ["A업체는 왜 12% 높은가요?", "D업체는 왜 제외되었나요?", "계산 근거 알려줘", "확인 필요 조건이 뭐야?"]) {
    assert.equal(priceQuestion(q, sample.data, selected, analysis)?.itemCode, "ITM-1001", q);
    assert.equal(priceQuestion(q, sample.data, selected), null, q);
  }
  assert.equal(priceQuestion("오늘 날씨 알려줘", sample.data, selected, analysis), null);
});

test("named supplier narrows rows only for explicit only request including natural Korean aliases", () => {
  for (const q of ["SUP-001만 시장 참고가격과 비교", "업체 A만 시장 참고가격과 비교", "A업체만 시장 참고가격과 비교"]) assert.deepEqual(priceQuestion(q, sample.data, selected, analysis)?.supplierIds, ["SUP-001"], q);
  assert.deepEqual(priceQuestion("A업체는 왜 12% 높아?", sample.data, selected, analysis)?.supplierIds, analysis.supplierIds, "mentioning one supplier in an explanation preserves the existing comparison scope");
});

test("explanation follow-up preserves a narrowed current comparison until an explicit new comparison", () => {
  const narrowed = buildPriceAnalysis(sample.data, sample.meta, inputs, { itemCode: "ITM-1001", supplierIds: ["SUP-001"] });
  for (const q of ["왜 12% 높아?", "계산 근거 알려줘", "확인 필요 조건은 뭐야?"]) {
    assert.deepEqual(priceQuestion(q, sample.data, selected, narrowed)?.supplierIds, ["SUP-001"], q);
  }
  for (const q of ["ITM-1001 업체별 단가를 시장 참고가격과 비교", "전체 업체 시장 참고가격 비교", "모든 업체의 계산 근거 알려줘"]) {
    assert.equal(priceQuestion(q, sample.data, selected, narrowed)?.supplierIds, undefined, q);
  }
  assert.equal(priceQuestion("왜 높은지 근거 알려줘", sample.data, { ...selected, itemCode: "ITM-1002" }, narrowed)?.supplierIds, undefined, "a new selected item cannot inherit the previous item's supplier restriction");
});

test("existing evaluation and delivery questions retain original analysis intent", async () => {
  for (const q of ["업체 A 평가 근거 알려줘", "업체 D 등급은 왜 낮아?", "납기 준수율 낮은 업체", "불량률 높은 업체는?"]) assert.equal(priceQuestion(q, sample.data, selected, analysis), null, q);
  const derived = derive(sample.data, sample.meta.asOf);
  const response = await answer("업체 A 평가 근거 알려줘", { ...sample, derived, selection: selected, lastResult: null, pending: null }, null);
  assert.equal(response.type, "analysis");
  if (response.type === "analysis") {
    assert.equal(response.result.kind, "supplier_profile");
    assert.equal(response.result.priceAnalysis, undefined);
    assert.ok(response.result.rows.some((row) => row.supplierId === "SUP-001"));
  }
});

test("existing material and wage routes are not captured by finished part market comparison", () => {
  for (const q of ["국제 니켈 시장가격 최근 6개월", "니켈 가격 차이율 알려줘", "CNC 공작기계 조작원 임금은 왜 올랐어?"]) {
    assert.equal(priceQuestion(q, sample.data, selected, analysis), null, q);
    assert.notEqual(detectMarketTopic(q, sample.data, sample.meta.asOf), null, q);
  }
});
