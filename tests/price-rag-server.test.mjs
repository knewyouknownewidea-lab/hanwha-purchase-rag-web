import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { createRagFetchHandler } from "../server/rag-fetch.mjs";

const TOKEN = "test-only-gateway-token-0123456789abcdef";
const JOB = "cb87b92d-3822-4d2a-8d05-7cc553e803ba";
const SESSION = "S".repeat(43);
const REF = { analysis_id: "price-test-1", revision: "price-edit-v2" };
function body() {
  return { question: "A업체 단가 차이 설명", model: "qwen3:8b", context: {
    ...REF, data_id: "sample", as_of: "2026-10-15", item: { itemCode: "ITM-1001", name: "실린더 라이너", spec: null, unit: "EA" },
    supplier_ids: ["SUP-001"], conditions: {}, supplier_quotes: [], external_quotes: [],
    computed: { benchmark: {}, rows: [] }, evidence_ids: [], indicators: [],
  } };
}
function request(path = "/api/rag/price-explanations", value = body(), headers = {}, method = "POST") {
  return new Request("https://purchase.test" + path, { method, headers: { "content-type": "application/json", "x-rag-session": SESSION, ...headers }, ...(method === "POST" ? { body: typeof value === "string" ? value : JSON.stringify(value) } : {}) });
}
function setup(fn) {
  return createRagFetchHandler({ RAG_ORIGIN: "https://gateway.test", RAG_GATEWAY_TOKEN: TOKEN }, { cryptoImpl: webcrypto, fetchImpl: fn });
}
function json(value, status = 202) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
function indicator() { return { id: "fx-usd-krw", kind: "fx", label: "USD/KRW 참고 환율", status: "connected", value: 1324.45, unit: "KRW / USD", currency: "KRW", source: "테스트 API", sourceUrl: "https://example.test/fx", observedAt: "2026-10-23", fetchedAt: "2026-10-26T01:00:00Z", message: "완성부품 가격 계산에는 사용하지 않습니다.", isSample: false }; }

test("price explanation uses fixed route, scoped visitor, context identity, and safe cookie", async () => {
  const calls = [];
  const handle = setup(async (url, init) => { calls.push({ url, init }); return json({ job_id: JOB, status: "running", price_context: REF, owner: "private" }); });
  const response = await handle(request(undefined, body(), { authorization: "Bearer browser-secret", "x-rag-visitor": "spoof" }));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { job_id: JOB, status: "running", price_context: REF });
  assert.equal(response.headers.get("location"), "/api/rag/jobs/" + JOB);
  assert.match(response.headers.get("set-cookie"), /HttpOnly; SameSite=Lax/);
  assert.equal(calls[0].url, "https://gateway.test/price-explanations");
  assert.equal(calls[0].init.headers.authorization, "Bearer " + TOKEN);
  assert.match(calls[0].init.headers["x-rag-visitor"], /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(calls[0].init.headers["x-rag-visitor"], SESSION);
  assert.equal(calls[0].init.headers["x-rag-session"], undefined);
  assert.deepEqual(JSON.parse(calls[0].init.body), body());
});

test("price request requires session, qwen model, exact envelope and bounded context", async () => {
  let calls = 0;
  const handle = setup(async () => { calls++; return json({}); });
  const noSession = request(); noSession.headers.delete("x-rag-session");
  assert.equal((await handle(noSession)).status, 400);
  for (const mutate of [
    (v) => { v.model = "gemma3:4b"; }, (v) => { v.owner = "private"; }, (v) => { v.supplier_id = 1; },
    (v) => { v.context.dataset = {}; }, (v) => { v.context.supplier_ids = ["SUP-001", "SUP-001"]; },
    (v) => { v.context.revision = ""; }, (v) => { v.context.analysis_id = "not-price-context"; },
  ]) {
    const value = body(); mutate(value);
    assert.equal((await handle(request(undefined, value))).status, 422);
  }
  assert.equal(calls, 0);
});

test("bounded external indicators retain the request snapshot and reject false status/value metadata", async () => {
  let sent;
  const handle = setup(async (_url, init) => { sent = JSON.parse(init.body); return json({ job_id: JOB, status: "running", price_context: REF }); });
  const value = body(); value.context.indicators = [indicator()];
  assert.equal((await handle(request(undefined, value))).status, 202);
  assert.deepEqual(sent.context.indicators, value.context.indicators);
  for (const mutate of [(i) => { i.token = "private"; }, (i) => { i.value = true; }, (i) => { i.status = "unavailable"; }, (i) => { i.status = "example"; }, (i) => { i.sourceUrl = "https://user:pass@example.test/fx"; }, (i) => { i.fetchedAt = "not-a-date"; }, (i) => { i.label = "x".repeat(201); }]) {
    const item = indicator(); mutate(item); const invalid = body(); invalid.context.indicators = [item];
    assert.equal((await handle(request(undefined, invalid))).status, 422);
  }
  value.context.indicators = [indicator(), indicator()];
  assert.equal((await handle(request(undefined, value))).status, 422);
});

test("256 KiB request limit applies to price route while normal jobs keep 8 KiB", async () => {
  const handle = setup(async () => json({ job_id: JOB, status: "running", price_context: REF }));
  const value = body(); value.context.computed.rows = [{ padding: "x".repeat(20000) }];
  assert.equal((await handle(request(undefined, value))).status, 202);
  assert.equal((await handle(request("/api/rag/jobs", value))).status, 413);
  assert.equal((await handle(request(undefined, " ".repeat(256 * 1024 + 1)))).status, 413);
});

test("price POST refuses missing or stale upstream analysis identity", async () => {
  for (const ref of [undefined, { ...REF, revision: "stale" }, { ...REF, extra: "private" }]) {
    const handle = setup(async () => json({ job_id: JOB, status: "running", ...(ref ? { price_context: ref } : {}) }));
    assert.equal((await handle(request())).status, 502);
  }
});

test("price polling exposes verified code and explanation but suppresses internal context", async () => {
  const result = { status: "answered", answer: "서버 계산과 조건 설명 [E1]", sources: [], price_context: REF,
    calculation_text: "서버 계산", explanation: "조건 설명 [E1]", owner: "private", raw_context: { private: true } };
  const handle = setup(async () => json({ job_id: JOB, status: "succeeded", price_context: REF, result }, 200));
  const response = await handle(request("/api/rag/jobs/" + JOB, null, {}, "GET"));
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.deepEqual(value.price_context, REF);
  assert.deepEqual(value.result.price_context, REF);
  assert.equal(value.result.calculation_text, "서버 계산");
  assert.equal(value.result.explanation, "조건 설명 [E1]");
  assert.equal(value.result.owner, undefined);
  assert.equal(value.result.raw_context, undefined);
});

test("price polling rejects mismatched result context, mixed datasets, and missing session", async () => {
  for (const mutate of [
    (job) => { job.result.price_context = { ...REF, revision: "old" }; },
    (job) => { delete job.result.calculation_text; },
    (job) => { job.dataset = { id: JOB, revision: "a".repeat(64) }; },
  ]) {
    const job = { job_id: JOB, status: "succeeded", price_context: REF, result: { status: "answered", answer: "설명", sources: [], price_context: REF, calculation_text: "계산", explanation: "설명" } };
    mutate(job);
    const handle = setup(async () => json(job, 200));
    assert.equal((await handle(request("/api/rag/jobs/" + JOB, null, {}, "GET"))).status, 502);
  }
  const handle = setup(async () => json({ job_id: JOB, status: "running", price_context: REF }, 200));
  const noSession = request("/api/rag/jobs/" + JOB, null, {}, "GET"); noSession.headers.delete("x-rag-session");
  assert.equal((await handle(noSession)).status, 502);
});

test("upstream errors are redacted and price identity cannot appear on normal submission", async () => {
  const handle = setup(async () => json({ error: TOKEN + " internal traceback" }, 500));
  const response = await handle(request());
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(TOKEN));
  const wrong = setup(async () => json({ job_id: JOB, status: "running", price_context: REF }));
  assert.equal((await wrong(request("/api/rag/jobs", { question: "질문", model: "qwen3:8b" }))).status, 502);
});
