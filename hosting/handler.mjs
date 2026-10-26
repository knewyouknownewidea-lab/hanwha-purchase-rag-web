// 표준 Fetch API만 사용하는 Sites Worker 라우터. 비밀값은 런타임 env로만 받는다.
import { createRagFetchHandler } from "../server/rag-fetch.mjs";

const MAX_PROMPT_CHARS = 60_000;
const MAX_PROMPT_BYTES = MAX_PROMPT_CHARS * 4;
const DEFAULT_MODEL = "claude-haiku-5-5";
const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
const HTML_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";
const present = (value) => typeof value === "string" && !!value.trim();

function secure(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function json(status, body, extra = {}) {
  return secure(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...extra } }));
}
class RequestProblem extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
async function boundedJson(message, limit) {
  const declared = message.headers.get("content-length");
  if (declared !== null && (!/^\d{1,10}$/.test(declared) || Number(declared) > limit)) throw new RequestProblem(413, "요청 본문이 너무 큽니다.");
  const reader = message.body?.getReader();
  if (!reader) throw new RequestProblem(400, "JSON 형식으로 요청해 주세요.");
  let size = 0;
  const parts = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        // 취소 완료가 보장되지 않는 스트림도 오류 응답을 막지 않도록 정리만 요청한다.
        void reader.cancel().catch(() => {});
        throw new RequestProblem(413, "요청 본문이 너무 큽니다.");
      }
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new RequestProblem(400, "올바른 JSON 형식으로 요청해 주세요."); }
  } finally { reader.releaseLock(); }
}

export function createHostingHandler(env = {}, { html = "", fetchImpl = fetch, cryptoImpl = globalThis.crypto, aiTimeoutMs = 30_000, ragOptions = {}, ragFactory = createRagFetchHandler } = {}) {
  const rag = ragFactory(env, { fetchImpl, cryptoImpl, ...ragOptions });
  const enabled = present(env.ANTHROPIC_API_KEY);
  const model = present(env.LLM_MODEL) ? env.LLM_MODEL.trim() : DEFAULT_MODEL;
  return async function handle(request) {
    const url = new URL(request.url);
    try {
      const ragResponse = await rag(request);
      if (ragResponse) return secure(ragResponse);
      if (url.pathname === "/api/ai/status") {
        if (request.method !== "GET") return json(405, { error: "지원하지 않는 요청 방식입니다." }, { allow: "GET" });
        return json(200, { enabled, model: enabled ? model : null });
      }
      if (url.pathname === "/api/ai/interpret") {
        if (request.method !== "POST") return json(405, { error: "지원하지 않는 요청 방식입니다." }, { allow: "POST" });
        if (!enabled) return json(503, { error: "LLM 질문 해석이 설정되지 않았습니다. 웹 데이터 분석의 규칙 기반 모드를 사용할 수 있습니다." });
        if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return json(415, { error: "JSON 형식으로 요청해 주세요." });
        const body = await boundedJson(request, MAX_PROMPT_BYTES);
        if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > MAX_PROMPT_CHARS) return json(400, { error: "prompt가 비었거나 너무 깁니다." });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), aiTimeoutMs);
        try {
          const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
            method: "POST", signal: controller.signal,
            headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model, max_tokens: 400, system: "You convert a Korean procurement question into one JSON object exactly as instructed. Reply with JSON only.", messages: [{ role: "user", content: body.prompt }] }),
          });
          if (!response.ok) {
            void response.body?.cancel().catch(() => {});
            return json(502, { error: "LLM 질문 해석 요청을 완료하지 못했습니다. 서버 설정을 확인해 주세요." });
          }
          const result = await boundedJson(response, 256 * 1024);
          const text = Array.isArray(result?.content) ? result.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("") : "";
          if (!text.trim() || result?.error) return json(502, { error: "LLM 질문 해석 응답 형식이 올바르지 않습니다." });
          return json(200, { text });
        } catch {
          return json(controller.signal.aborted ? 504 : 502, { error: controller.signal.aborted ? "LLM 질문 해석 응답 시간이 초과되었습니다." : "LLM 질문 해석 서비스를 사용할 수 없습니다." });
        } finally { clearTimeout(timer); }
      }
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return json(404, { error: "지원하지 않는 API입니다." });
      if (!["GET", "HEAD"].includes(request.method)) return json(405, { error: "지원하지 않는 요청 방식입니다." }, { allow: "GET, HEAD" });
      return secure(new Response(request.method === "HEAD" ? null : html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": HTML_CSP } }));
    } catch (error) {
      if (error instanceof RequestProblem) return json(error.status, { error: error.message });
      return json(500, { error: "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." });
    }
  };
}
