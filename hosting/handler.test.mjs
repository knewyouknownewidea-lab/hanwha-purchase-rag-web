import assert from "node:assert/strict";
import test from "node:test";
import { createHostingHandler } from "./handler.mjs";

const origin = "https://hanwha.example";
const html = "<!doctype html><html lang='ko'><body>한화엔진 SAMPLE · 실제 자료 아님</body></html>";
const apiKey = "test-only-anthropic-key-0123456789abcdef";
const noRag = () => async () => null;
const handler = (env = {}, options = {}) => createHostingHandler(env, { html, ragFactory: noRag, ...options });
const request = (path, options) => new Request(origin + path, options);
const post = (body, headers = { "content-type": "application/json" }) => ({ method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const responseJson = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
async function promptly(task) {
  let timer;
  try {
    return await Promise.race([task, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("스트림 취소 대기로 오류 응답이 멈췄습니다.")), 100); })]);
  } finally { clearTimeout(timer); }
}

test("기존 SPA와 SAMPLE 표기를 그대로 반환", async () => {
  const response = await handler()(request("/"));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), html);
  assert.match(response.headers.get("content-type"), /text\/html/);
});
test("SPA 하위 주소·쿼리와 HEAD 지원", async () => {
  const app = handler();
  assert.equal(await (await app(request("/purchase/detail?view=rag"))).text(), html);
  const head = await app(request("/", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.match(head.headers.get("content-type"), /text\/html/);
});
test("정적 응답의 no-store·폰트·동일출처 CSP", async () => {
  const response = await handler()(request("/"));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
  assert.match(response.headers.get("content-security-policy"), /fonts\.googleapis\.com/);
  assert.match(response.headers.get("content-security-policy"), /fonts\.gstatic\.com/);
});
test("정적 주소에 POST하면 HTML 대신 명시적인 405", async () => {
  const response = await handler()(request("/", { method: "POST" }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
  assert.ok((await response.json()).error);
});
test("알 수 없는 API는 SPA 대신 JSON 404", async () => {
  for (const path of ["/api", "/api/not-real", "/api/ai/unknown"]) {
    const response = await handler()(request(path));
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.ok((await response.json()).error);
  }
});
test("RAG 경로는 공통코어에 그대로 위임하고 쿠키·세션을 보존", async () => {
  let seen;
  const app = handler({}, { ragFactory: () => async (incoming) => {
    seen = incoming;
    return new Response('{"enabled":true}', { headers: { "content-type": "application/json", "set-cookie": "rag_visitor=test.signature; Path=/api/rag; HttpOnly; Secure; SameSite=Lax" } });
  } });
  const incoming = request("/api/rag/status", { headers: { "X-Rag-Session": "s".repeat(43), cookie: "rag_visitor=test.signature" } });
  const response = await app(incoming);
  assert.equal(seen, incoming);
  assert.equal(seen.headers.get("X-Rag-Session"), "s".repeat(43));
  assert.equal(seen.headers.get("cookie"), "rag_visitor=test.signature");
  assert.match(response.headers.get("set-cookie"), /Path=\/api\/rag; HttpOnly; Secure/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { enabled: true });
});
test("공통코어의 실패 상태도 변경하지 않음", async () => {
  const app = handler({}, { ragFactory: () => async () => responseJson({ error: "질문 한도" }, 429) });
  const response = await app(request("/api/rag/jobs", post({ question: "수량" })));
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "질문 한도" });
});
test("런타임 RAG 환경변수와 fetch·crypto를 코어에 전달", async () => {
  const env = { RAG_ORIGIN: "https://gateway.example", RAG_GATEWAY_TOKEN: "test-only-token-0123456789abcdef0123456789" };
  const fetchImpl = async () => responseJson({});
  const cryptoImpl = { test: true };
  let options;
  const app = handler(env, { fetchImpl, cryptoImpl, ragFactory: (actualEnv, actualOptions) => {
    assert.equal(actualEnv, env);
    options = actualOptions;
    return async () => responseJson({ enabled: true });
  } });
  await app(request("/api/rag/status"));
  assert.equal(options.fetchImpl, fetchImpl);
  assert.equal(options.cryptoImpl, cryptoImpl);
});
test("LLM 설정 없음·빈 값은 enabled:false", async () => {
  for (const env of [{}, { ANTHROPIC_API_KEY: "  " }]) {
    const response = await handler(env)(request("/api/ai/status"));
    assert.deepEqual(await response.json(), { enabled: false, model: null });
  }
});
test("LLM 키는 상태 응답에 없고 모델만 표시", async () => {
  const response = await handler({ ANTHROPIC_API_KEY: apiKey, LLM_MODEL: "configured-model" })(request("/api/ai/status"));
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { enabled: true, model: "configured-model" });
  assert.ok(!text.includes(apiKey));
});
test("키 없이 해석 API 호출 시 외부 요청 없이 안전한 503", async () => {
  let count = 0;
  const response = await handler({}, { fetchImpl: async () => { count++; throw new Error("must not fetch"); } })(request("/api/ai/interpret", post({ prompt: "질문 해석" })));
  assert.equal(response.status, 503);
  assert.equal(count, 0);
  assert.match((await response.json()).error, /설정되지 않았습니다/);
});
test("LLM API의 메서드 제약", async () => {
  const app = handler();
  assert.equal((await app(request("/api/ai/status", { method: "POST" }))).status, 405);
  assert.equal((await app(request("/api/ai/interpret"))).status, 405);
});
test("정상 해석 응답은 기존 {text} 계약을 유지", async () => {
  let outbound;
  const response = await handler({ ANTHROPIC_API_KEY: apiKey, LLM_MODEL: "configured-model" }, { fetchImpl: async (url, init) => {
    outbound = { url, init };
    return responseJson({ content: [{ type: "text", text: '{"intent":' }, { type: "image", text: "ignored" }, { type: "text", text: '"help"}' }] });
  } })(request("/api/ai/interpret", post({ prompt: "사용법" })));
  assert.equal(outbound.url, "https://api.anthropic.com/v1/messages");
  assert.equal(outbound.init.headers["x-api-key"], apiKey);
  const payload = JSON.parse(outbound.init.body);
  assert.equal(payload.model, "configured-model");
  assert.equal(payload.messages[0].content, "사용법");
  assert.equal(payload.max_tokens, 400);
  assert.deepEqual(await response.json(), { text: '{"intent":"help"}' });
});
test("공백·과도한 prompt·비객체 본문 거절", async () => {
  const app = handler({ ANTHROPIC_API_KEY: apiKey });
  for (const body of [{ prompt: " " }, { prompt: "a".repeat(60_001) }, [], null, { question: "wrong" }]) {
    assert.equal((await app(request("/api/ai/interpret", post(body)))).status, 400);
  }
});
test("JSON이 아닌 입력과 잘못된 JSON 거절", async () => {
  const app = handler({ ANTHROPIC_API_KEY: apiKey });
  assert.equal((await app(request("/api/ai/interpret", post("prompt=test", { "content-type": "application/x-www-form-urlencoded" })))).status, 415);
  assert.equal((await app(request("/api/ai/interpret", post("{")))).status, 400);
});
test("입력 바이트 한도 검사", async () => {
  const app = handler({ ANTHROPIC_API_KEY: apiKey });
  const response = await app(request("/api/ai/interpret", post({ prompt: "가".repeat(90_000) })));
  assert.equal(response.status, 413);
});
test("상류 실패 본문이나 비밀값을 공개하지 않음", async () => {
  const response = await handler({ ANTHROPIC_API_KEY: apiKey }, { fetchImpl: async () => responseJson({ error: "private " + apiKey }, 401) })(request("/api/ai/interpret", post({ prompt: "사용법" })));
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(apiKey));
});
test("상류 오류 스트림의 cancel이 끝나지 않아도 502를 즉시 반환", async () => {
  let cancelled = 0;
  const body = new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } });
  const app = handler({ ANTHROPIC_API_KEY: apiKey }, { fetchImpl: async () => new Response(body, { status: 401 }), aiTimeoutMs: 5 });
  const response = await promptly(app(request("/api/ai/interpret", post({ prompt: "사용법" }))));
  assert.equal(response.status, 502);
  assert.equal(cancelled, 1);
});
test("초과 입력 스트림의 cancel이 끝나지 않아도 413을 즉시 반환", async () => {
  let cancelled = 0;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(240_001)); },
    cancel() { cancelled++; return new Promise(() => {}); },
  });
  const incoming = request("/api/ai/interpret", { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" });
  const response = await promptly(handler({ ANTHROPIC_API_KEY: apiKey })(incoming));
  assert.equal(response.status, 413);
  assert.equal(cancelled, 1);
});
test("네트워크 예외의 비밀값을 공개하지 않음", async () => {
  const response = await handler({ ANTHROPIC_API_KEY: apiKey }, { fetchImpl: async () => { throw new Error("private " + apiKey); } })(request("/api/ai/interpret", post({ prompt: "사용법" })));
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(apiKey));
});
test("해석 응답 시간 초과는 명시적인 504", async () => {
  const fetchImpl = async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  const response = await handler({ ANTHROPIC_API_KEY: apiKey }, { fetchImpl, aiTimeoutMs: 5 })(request("/api/ai/interpret", post({ prompt: "사용법" })));
  assert.equal(response.status, 504);
});
test("비정상 해석 응답을 성공으로 표시하지 않음", async () => {
  for (const result of [{}, { content: [{ type: "text", text: " " }] }, { content: [{ type: "text", text: "valid" }], error: true }]) {
    const response = await handler({ ANTHROPIC_API_KEY: apiKey }, { fetchImpl: async () => responseJson(result) })(request("/api/ai/interpret", post({ prompt: "사용법" })));
    assert.equal(response.status, 502);
  }
});
test("예상하지 못한 라우터 예외는 안전한 JSON 500", async () => {
  const response = await handler({}, { ragFactory: () => async () => { throw new Error(apiKey); } })(request("/api/rag/status"));
  assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes(apiKey));
});
