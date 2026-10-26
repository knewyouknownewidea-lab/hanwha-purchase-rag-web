// 고정된 외부 환율 한 쌍만 직접 조회한다. 임의 URL·거래가격 변환·예시값 대체는 허용하지 않는다.
export const FX_URL = "https://api.frankfurter.dev/v2/providers/ecb/rate/usd/krw";
const source = "Frankfurter · European Central Bank";
const unavailable = (fetchedAt, message) => ({ id: "ecb-usd-krw", kind: "fx", label: "USD/KRW 참고 환율", status: "unavailable", source, sourceUrl: FX_URL, observedAt: null, fetchedAt, value: null, unit: "KRW / USD", currency: "KRW", message, isSample: false });
export const unconfiguredIndicators = () => [
  { id: "material-api", kind: "material", label: "원자재 가격 API", status: "not_configured", source: "미연결", sourceUrl: null, observedAt: null, fetchedAt: null, value: null, unit: "–", currency: null, message: "실제 원자재 API가 연결되지 않았습니다. 기존 시세 화면은 SAMPLE 가상 자료입니다.", isSample: false },
  { id: "price-index-api", kind: "index", label: "관련 가격지수 API", status: "not_configured", source: "미연결", sourceUrl: null, observedAt: null, fetchedAt: null, value: null, unit: "–", currency: null, message: "실제 가격지수 API가 연결되지 않았습니다. 완성부품 참고가격 산정에 사용하지 않습니다.", isSample: false },
];

async function boundedJson(response) {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) throw new Error("invalid content type");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing response body");
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16 * 1024) { void reader.cancel().catch(() => {}); throw new Error("oversized response"); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally { reader.releaseLock(); }
}

export function createMarketHandler({ fetchImpl = fetch, now = () => new Date(), timeoutMs = 5000 } = {}) {
  return async function market(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/market/indicators") return null;
    const reply = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
    if (request.method !== "GET") return reply(405, { error: "GET 요청만 지원합니다." }, { allow: "GET" });
    if (url.search) return reply(400, { error: "이 API는 고정된 참고 지표만 조회합니다." });
    const fetchedAt = now().toISOString();
    const controller = new AbortController();
    const aborted = () => controller.abort();
    request.signal.addEventListener("abort", aborted, { once: true });
    const timer = setTimeout(aborted, timeoutMs);
    let fx;
    try {
      if (request.signal.aborted) throw new Error("aborted");
      const response = await fetchImpl(FX_URL, { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: controller.signal });
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error("provider unavailable"); }
      const data = await boundedJson(response);
      const day = typeof data.date === "string" ? data.date : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day + "T00:00:00Z")) || new Date(day).toISOString().slice(0, 10) !== day || day > fetchedAt.slice(0, 10) || data.base !== "USD" || data.quote !== "KRW" || typeof data.rate !== "number" || !Number.isFinite(data.rate) || data.rate <= 0 || data.rate > 1_000_000) throw new Error("invalid provider data");
      fx = { id: "ecb-usd-krw", kind: "fx", label: "USD/KRW 참고 환율", status: "connected", source, sourceUrl: FX_URL, observedAt: day, fetchedAt, value: data.rate, unit: "KRW / USD", currency: "KRW", message: "실제 API 조회값입니다. 완성부품의 시장 참고가격·비교 조건·차이율 계산에는 사용하지 않습니다.", isSample: false };
    } catch {
      fx = unavailable(fetchedAt, controller.signal.aborted ? "환율 API 조회 시간이 초과되었거나 요청이 취소되었습니다. 예시값으로 대체하지 않았습니다." : "환율 API 조회에 실패했습니다. 실제 조회값이 없으며 예시값으로 대체하지 않았습니다.");
    } finally { clearTimeout(timer); request.signal.removeEventListener("abort", aborted); }
    return reply(200, { indicators: [fx, ...unconfiguredIndicators()] });
  };
}
