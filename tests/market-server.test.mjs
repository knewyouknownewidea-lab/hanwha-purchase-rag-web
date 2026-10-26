import test from "node:test";
import assert from "node:assert/strict";
import { createMarketHandler, FX_URL } from "../server/market.mjs";
const url = "https://example.test/api/market/indicators";
const now = () => new Date("2026-10-26T06:00:00Z");
const request = () => new Request(url);
const response = (data = { date: "2026-10-23", base: "USD", quote: "KRW", rate: 1324.45 }) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

test("실제 관측값 계약과 관측일·조회시각·출처를 보존하고 미연결 지표를 구분", async () => {
  const handler = createMarketHandler({ now, fetchImpl: async (target, options) => { assert.equal(target, FX_URL); assert.equal(options.redirect, "error"); assert.deepEqual(Object.keys(options.headers), ["accept"]); return response(); } });
  const r = await handler(request()); const b = await r.json();
  assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(b.indicators.map(i => i.status), ["connected", "not_configured", "not_configured"]);
  assert.equal(b.indicators[0].value, 1324.45); assert.equal(b.indicators[0].observedAt, "2026-10-23"); assert.equal(b.indicators[0].fetchedAt, now().toISOString()); assert.equal(b.indicators[0].isSample, false);
});
test("임의 URL·쿼리·메서드는 외부 조회 전에 거절", async () => {
  const handler = createMarketHandler({ fetchImpl: async () => { throw new Error("must not run"); } });
  assert.equal(await handler(new Request("https://example.test/other")), null);
  assert.equal((await handler(new Request(url + "?url=https://evil.test"))).status, 400);
  assert.equal((await handler(new Request(url, { method: "POST" }))).status, 405);
});
test("API 실패·HTML·과도한 응답은 가격이나 예시값으로 대체하지 않음", async () => {
  for (const fetchImpl of [async () => new Response("secret provider message", { status: 503 }), async () => new Response("<html>bad</html>"), async () => new Response(" ".repeat(20_000), { headers: { "content-type": "application/json" } }), async () => { throw new Error("private error"); }]) {
    const b = await (await createMarketHandler({ now, fetchImpl })(request())).json();
    assert.equal(b.indicators[0].status, "unavailable"); assert.equal(b.indicators[0].value, null); assert.equal(b.indicators[0].observedAt, null); assert.ok(!JSON.stringify(b).includes("private error"));
  }
});
test("잘못된 날짜·통화·비정상 환율을 실제 조회 성공으로 표시하지 않음", async () => {
  for (const change of [{ date: "2026-02-30" }, { date: "2026-10-27" }, { base: "EUR" }, { quote: "USD" }, { rate: 0 }, { rate: -1 }, { rate: "1324.45" }, { rate: null }]) {
    const b = await (await createMarketHandler({ now, fetchImpl: async () => response({ date: "2026-10-23", base: "USD", quote: "KRW", rate: 1324.45, ...change }) })(request())).json();
    assert.equal(b.indicators[0].status, "unavailable"); assert.equal(b.indicators[0].value, null);
  }
});
test("실제 fetch 취소 신호로 timeout을 전파하고 실패 상태를 반환", async () => {
  const handler = createMarketHandler({ now, timeoutMs: 5, fetchImpl: async (_target, options) => new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")))) });
  const b = await (await handler(request())).json(); assert.equal(b.indicators[0].status, "unavailable"); assert.equal(b.indicators[0].value, null);
});
