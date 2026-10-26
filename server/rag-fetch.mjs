// Node와 Worker가 공유하는 Fetch API 중계입니다. 환경·비밀 값은 서버에서 주입합니다.

export const RAG_MODELS = Object.freeze(["qwen3:8b", "gemma3:4b", "llama3.1:8b"]);
const DOCUMENT_TYPES = new Set(["supplier", "part", "supplier_part", "order", "complaint"]);
const INPUT_FIELDS = new Set(["question", "model", "top_k", "order_id", "supplier_id", "part_id", "document_type", "dataset"]);
const TABLES = new Set(["suppliers", "items", "purchaseOrders", "contracts", "inventory", "bom", "materialPrices", "fxRates", "laborWages", "competitorSupply", "industryNews"]);
const SNAPSHOT_FIELDS = new Set(["schema_version", "client_revision", "meta", "data"]);
const META_FIELDS = new Set(["asOf", "isSample", "label", "sources", "uploaded"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COOKIE = "rag_visitor";
const VISITOR = /^[A-Za-z0-9_-]{43}$/;
const REVISION = /^[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 8192;
const MAX_DATASET_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const OFFLINE = "RAG 연결 설정이 필요합니다. 관리자에게 문의해 주세요.";
const BAD_INPUT = "질문·모델·조회 조건의 형식이나 범위를 확인해 주세요.";
const UNAVAILABLE = "RAG 답변 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.";
const BAD_SNAPSHOT = "웹 데이터 스냅샷의 형식이나 크기를 확인해 주세요.";
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const exactFields = (value, allowed) => record(value) && Object.keys(value).every((key) => allowed.has(key));

class RagError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function configuration(env) {
  try {
    const raw = env.RAG_ORIGIN;
    const token = env.RAG_GATEWAY_TOKEN;
    if (typeof raw !== "string" || raw !== raw.trim() || !/^[\x21-\x7e]{32,4096}$/.test(token || "")) return null;
    const url = new URL(raw);
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return { origin: url.origin, token };
  } catch {
    return null;
  }
}

function send(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  } });
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signatureBytes(value) {
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "="), (char) => char.charCodeAt(0));
    // atob가 무시하는 마지막 padding bit 변경도 기존 Node 서명과 동일하게 거절합니다.
    return bytes.length === 32 && base64url(bytes) === value ? bytes : null;
  } catch { return null; }
}

function hmac(cryptoImpl, token) {
  let key;
  const encoder = new TextEncoder();
  const getKey = () => key ??= cryptoImpl.subtle.importKey("raw", encoder.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return {
    async sign(value) { return base64url(new Uint8Array(await cryptoImpl.subtle.sign("HMAC", await getKey(), encoder.encode(value)))); },
    async verify(value, signature) { return cryptoImpl.subtle.verify("HMAC", await getKey(), signature, encoder.encode(value)); },
  };
}

async function identify(request, headers, signer, cryptoImpl) {
  // 사용자가 보낸 Authorization/X-Rag-Visitor는 사용하지 않습니다.
  const cookies = (request.headers.get("cookie") || "").split(";").map((value) => value.trim()).filter((value) => value.startsWith(COOKIE + "="));
  if (cookies.length === 1) {
    const [visitor, signed, extra] = cookies[0].slice(COOKIE.length + 1).split(".");
    if (VISITOR.test(visitor || "") && VISITOR.test(signed || "") && extra === undefined) {
      const bytes = signatureBytes(signed);
      if (bytes && await signer.verify("hanwha-rag-visitor-v1:" + visitor, bytes)) return visitor;
    }
  }
  const visitor = base64url(cryptoImpl.getRandomValues(new Uint8Array(32)));
  const secure = new URL(request.url).protocol === "https:";
  headers["set-cookie"] = `${COOKIE}=${visitor}.${await signer.sign("hanwha-rag-visitor-v1:" + visitor)}; Path=/api/rag; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? "; Secure" : ""}`;
  return visitor;
}

async function readBody(request, maxBytes = MAX_BODY_BYTES) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new RagError(415, "JSON 형식으로 요청해 주세요.");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,10}$/.test(declared) || Number(declared) > maxBytes)) {
    throw new RagError(413, "요청 본문이 너무 큽니다.");
  }
  const buffer = await boundedBytes(request.body, maxBytes, new RagError(413, "요청 본문이 너무 큽니다."), new RagError(400, "요청을 읽을 수 없습니다."));
  try { return JSON.parse(new TextDecoder().decode(buffer)); }
  catch { throw new RagError(400, "올바른 JSON 형식으로 요청해 주세요."); }
}

function validateInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !INPUT_FIELDS.has(key))) throw new RagError(422, BAD_INPUT);
  if (typeof value.question !== "string" || !value.question.trim() || value.question.length > 1000 || !RAG_MODELS.includes(value.model)) throw new RagError(422, BAD_INPUT);
  const payload = { question: value.question.trim(), model: value.model };
  if (value.dataset !== undefined) {
    if (!validDatasetRef(value.dataset) || ["order_id", "supplier_id", "part_id", "document_type"].some((key) => Object.hasOwn(value, key))) throw new RagError(422, BAD_INPUT);
    payload.dataset = { id: value.dataset.id, revision: value.dataset.revision };
  }
  if (value.top_k !== undefined) {
    if (!Number.isSafeInteger(value.top_k) || value.top_k < 1 || value.top_k > 10) throw new RagError(422, BAD_INPUT);
    payload.top_k = value.top_k;
  }
  for (const key of ["order_id", "supplier_id", "part_id"]) {
    if (value[key] === undefined || value[key] === null) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) throw new RagError(422, BAD_INPUT);
    payload[key] = value[key];
  }
  if (value.document_type !== undefined && value.document_type !== null) {
    if (!DOCUMENT_TYPES.has(value.document_type)) throw new RagError(422, BAD_INPUT);
    payload.document_type = value.document_type;
  }
  return payload;
}

function validDatasetRef(value) {
  return record(value) && Object.keys(value).length === 2 && typeof value.id === "string" && UUID.test(value.id) && typeof value.revision === "string" && REVISION.test(value.revision);
}

function sameDataset(a, b) { return a.id === b.id && a.revision === b.revision; }

function validateSnapshot(value) {
  if (!exactFields(value, SNAPSHOT_FIELDS) || value.schema_version !== 1 || typeof value.client_revision !== "string" || !value.client_revision.trim() || value.client_revision.length > 128) throw new RagError(422, BAD_SNAPSHOT);
  const meta = value.meta;
  if (!exactFields(meta, META_FIELDS) || typeof meta.asOf !== "string" || !meta.asOf || meta.asOf.length > 32 || typeof meta.isSample !== "boolean" || typeof meta.label !== "string" || !meta.label.trim() || meta.label.length > 200) throw new RagError(422, BAD_SNAPSHOT);
  if (meta.sources !== undefined && (!exactFields(meta.sources, TABLES) || Object.values(meta.sources).some((source) => typeof source !== "string" || source.length > 256))) throw new RagError(422, BAD_SNAPSHOT);
  if (meta.uploaded !== undefined && (!Array.isArray(meta.uploaded) || meta.uploaded.length > TABLES.size || meta.uploaded.some((table) => !TABLES.has(table)) || new Set(meta.uploaded).size !== meta.uploaded.length)) throw new RagError(422, BAD_SNAPSHOT);
  if (!exactFields(value.data, TABLES) || Object.keys(value.data).length !== TABLES.size || Object.values(value.data).some((rows) => !Array.isArray(rows) || rows.some((row) => !record(row)))) throw new RagError(422, BAD_SNAPSHOT);
  if (Object.values(value.data).reduce((count, rows) => count + rows.length, 0) > 2000) throw new RagError(413, BAD_SNAPSHOT);
  return value;
}

function sessionScope(request, required) {
  const session = request.headers.get("x-rag-session");
  if ((session !== null && !VISITOR.test(session)) || (required && session === null)) throw new RagError(400, "RAG 검색 세션이 올바르지 않습니다. 화면을 새로고침해 주세요.");
  return session;
}

async function scopedVisitor(visitor, session, signer) {
  // 세션 값은 로그인 인증이 아닌 임의 capability입니다. 서명 쿠키와 결합한 값만 게이트웨이로 보냅니다.
  return session ? signer.sign("hanwha-rag-session-v1:" + visitor + ":" + session) : visitor;
}

function errorMessage(status) {
  if (status === 404) return "작업을 찾을 수 없거나 보관 시간이 지났습니다. 질문을 다시 보내 주세요.";
  if (status === 429) return "다른 질문을 처리 중이거나 질문 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.";
  if (status === 504) return "RAG 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.";
  if (status === 413) return "요청한 웹 데이터가 한도를 넘었습니다. 데이터 범위를 줄여 주세요.";
  if (status === 415) return "JSON 형식으로 요청해 주세요.";
  if ([400, 409, 422].includes(status)) return BAD_INPUT;
  return UNAVAILABLE;
}

async function boundedBytes(stream, maxBytes, oversized, unreadable) {
  const chunks = [];
  let size = 0;
  const reader = stream?.getReader();
  if (!reader) return new Uint8Array();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        // 취소가 끝날 때까지 응답을 지연시키지 않습니다. 런타임/어댑터가 남은 스트림을 정리합니다.
        void reader.cancel().catch(() => {});
        throw oversized;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    if (error instanceof RagError) throw error;
    throw unreadable;
  } finally { reader.releaseLock(); }
}

async function readResponse(response, maxBytes) {
  const bytes = await boundedBytes(response.body, maxBytes, new RagError(502, "RAG 응답 크기가 한도를 넘었습니다. 질문 범위를 좁혀 주세요."), new RagError(502, UNAVAILABLE));
  try {
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!record(data)) throw new Error("object required");
    return data;
  } catch { throw new RagError(502, UNAVAILABLE); }
}

function publicJob(data, jobId, submit, expectedDataset, hasSession) {
  if (!UUID.test(data.job_id || "") || (jobId && data.job_id !== jobId) || !["running", "succeeded", "failed"].includes(data.status) || (submit && data.status !== "running")) throw new RagError(502, UNAVAILABLE);
  const job = { job_id: data.job_id, status: data.status };
  if (data.dataset !== undefined) {
    if (!hasSession || (submit && !expectedDataset) || !validDatasetRef(data.dataset) || (expectedDataset && !sameDataset(data.dataset, expectedDataset))) throw new RagError(502, UNAVAILABLE);
    job.dataset = { id: data.dataset.id, revision: data.dataset.revision };
  } else if (expectedDataset) throw new RagError(502, UNAVAILABLE);
  if (data.status === "failed") {
    job.error_status = [400, 404, 409, 422, 429, 502, 503, 504].includes(data.error_status) ? data.error_status : 502;
    job.message = errorMessage(job.error_status);
  }
  if (data.status === "succeeded") {
    const result = data.result;
    if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.status !== "string" || (typeof result.answer !== "string" && result.answer !== null) || !Array.isArray(result.sources)) throw new RagError(502, UNAVAILABLE);
    // 게이트웨이 작업 메타데이터는 넘기지 않고, 공개 답변 계약만 전달합니다.
    job.result = {};
    for (const key of ["question", "status", "answer", "message", "generation_model", "model_called", "retrieval_method", "sources", "citation_check", "note"]) {
      if (Object.hasOwn(result, key)) job.result[key] = result[key];
    }
    if (job.dataset) {
      if (!validDatasetRef(result.dataset) || !sameDataset(result.dataset, job.dataset)) throw new RagError(502, UNAVAILABLE);
      job.result.dataset = { ...job.dataset };
    } else if (result.dataset !== undefined) throw new RagError(502, UNAVAILABLE);
  }
  return job;
}

function publicDataset(data, expectedId) {
  if (typeof data.dataset_id !== "string" || !UUID.test(data.dataset_id) || (expectedId && data.dataset_id !== expectedId) || typeof data.revision !== "string" || !REVISION.test(data.revision) || !["indexing", "ready", "failed"].includes(data.status) || !Number.isSafeInteger(data.row_count) || data.row_count < 0 || data.row_count > 2000 || !Number.isSafeInteger(data.chunk_count) || data.chunk_count < 0 || data.chunk_count > 2048) throw new RagError(502, UNAVAILABLE);
  return {
    dataset_id: data.dataset_id, revision: data.revision, status: data.status,
    row_count: data.row_count, chunk_count: data.chunk_count,
    ...(data.status === "failed" ? { message: "웹 데이터 검색 준비를 완료하지 못했습니다. 데이터 형식과 서버 상태를 확인해 주세요." } : {}),
  };
}

/** 환경은 서버 바인딩만 받습니다. 비RAG 경로는 정적 호스팅 등이 처리하도록 null을 반환합니다. */
export function createRagFetchHandler(env = {}, { fetchImpl = fetch, cryptoImpl = globalThis.crypto, timeoutMs = 10_000, maxResponseBytes = MAX_RESPONSE_BYTES } = {}) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== "function") throw new Error("RAG Web Crypto 실행 환경이 필요합니다.");
  const config = configuration(env);
  const signer = config ? hmac(cryptoImpl, config.token) : null;
  return async function handleRag(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/rag" && !url.pathname.startsWith("/api/rag/")) return null;
    const responseHeaders = {};
    const reply = (status, body, headers = {}) => send(status, body, { ...responseHeaders, ...headers });
    try {
      if (url.pathname === "/api/rag/status") {
        if (request.method !== "GET") return reply(405, { error: "지원하지 않는 요청 방식입니다." }, { allow: "GET" });
        return reply(200, { enabled: !!config, models: RAG_MODELS, ...(!config ? { message: OFFLINE } : {}) });
      }
      const submit = url.pathname === "/api/rag/jobs";
      const poll = /^\/api\/rag\/jobs\/([^/]+)$/.exec(url.pathname);
      const upload = url.pathname === "/api/rag/datasets";
      const datasetPath = /^\/api\/rag\/datasets\/([^/]+)$/.exec(url.pathname);
      const datasetRoute = upload || !!datasetPath;
      if (!submit && !poll && !datasetRoute) throw new RagError(404, "지원하지 않는 RAG 요청입니다.");
      const methods = submit || upload ? ["POST"] : datasetPath ? ["GET", "DELETE"] : ["GET"];
      if (!methods.includes(request.method)) return reply(405, { error: "지원하지 않는 요청 방식입니다." }, { allow: methods.join(", ") });
      const method = request.method;
      const pathId = datasetPath?.[1] || poll?.[1];
      if (url.search || (pathId && !UUID.test(pathId))) throw new RagError(400, BAD_INPUT);
      if (!config) throw new RagError(503, OFFLINE);
      const session = sessionScope(request, datasetRoute);
      const payload = upload ? validateSnapshot(await readBody(request, MAX_DATASET_BYTES)) : submit ? validateInput(await readBody(request)) : undefined;
      if (payload?.dataset && !session) sessionScope(request, true);
      const visitor = await scopedVisitor(await identify(request, responseHeaders, signer, cryptoImpl), session, signer);
      const controller = new AbortController();
      const aborted = () => controller.abort();
      if (request.signal.aborted) aborted();
      else request.signal.addEventListener("abort", aborted, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        if (controller.signal.aborted) throw new RagError(504, errorMessage(504));
        const upstreamPath = datasetRoute ? "/datasets" + (datasetPath ? "/" + datasetPath[1] : "") : "/jobs" + (poll ? "/" + poll[1] : "");
        const response = await fetchImpl(config.origin + upstreamPath, {
          method,
          headers: { "content-type": "application/json", authorization: "Bearer " + config.token, "x-rag-visitor": visitor },
          ...(payload ? { body: JSON.stringify(payload) } : {}),
          redirect: "manual",
          signal: controller.signal,
        });
        if (!response.ok) {
          // 인증 오류/리다이렉트/내부 오류 내용·헤더에는 비밀 값이 있을 수 있습니다.
          const status = [400, 404, 409, 413, 415, 422, 429, 503, 504].includes(response.status) ? response.status : 502;
          const retry = response.headers.get("retry-after");
          const headers = status === 429 && /^\d{1,6}$/.test(retry || "") ? { "retry-after": String(Math.max(1, Math.min(86400, Number(retry)))) } : {};
          void response.body?.cancel().catch(() => {});
          return reply(status, { error: errorMessage(status) }, headers);
        }
        const expectedStatus = submit || upload ? 202 : 200;
        if (response.status !== expectedStatus) { void response.body?.cancel().catch(() => {}); throw new RagError(502, UNAVAILABLE); }
        const raw = await readResponse(response, maxResponseBytes);
        let data;
        if (method === "DELETE") {
          if (raw.deleted !== true) throw new RagError(502, UNAVAILABLE);
          data = { deleted: true };
        } else if (datasetRoute) data = publicDataset(raw, datasetPath?.[1]);
        else data = publicJob(raw, poll?.[1], submit, payload?.dataset, !!session);
        const location = upload ? "/api/rag/datasets/" + data.dataset_id : submit ? "/api/rag/jobs/" + data.job_id : null;
        return reply(expectedStatus, data, location ? { location } : {});
      } catch (error) {
        if (controller.signal.aborted) throw new RagError(504, errorMessage(504));
        if (error instanceof RagError) throw error;
        throw new RagError(503, UNAVAILABLE);
      } finally { clearTimeout(timer); request.signal.removeEventListener("abort", aborted); }
    } catch (error) {
      return reply(error instanceof RagError ? error.status : 502, { error: error instanceof RagError ? error.message : UNAVAILABLE });
    }
  };
}
