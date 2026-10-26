// 로컬 Node 서버와 공통 Fetch 중계 사이의 어댑터입니다. 검증·인증 로직은 rag-fetch.mjs에 둡니다.
import { webcrypto } from "node:crypto";
import { createRagFetchHandler } from "./rag-fetch.mjs";
export { RAG_MODELS } from "./rag-fetch.mjs";

function requestBody(req) {
  let cleanup;
  return new ReadableStream({
    start(controller) {
      const data = (chunk) => { controller.enqueue(chunk); if (controller.desiredSize <= 0) req.pause(); };
      const end = () => { cleanup(); controller.close(); };
      const error = () => { cleanup(); controller.error(new Error("요청을 읽을 수 없습니다.")); };
      cleanup = () => {
        req.removeListener("data", data);
        req.removeListener("end", end);
        req.removeListener("error", error);
        req.removeListener("aborted", error);
      };
      req.pause();
      req.on("data", data);
      req.once("end", end);
      req.once("error", error);
      req.once("aborted", error);
    },
    pull() { req.resume(); },
    // Readable.toWeb(req)의 cancel은 소켓도 닫습니다. 본문 한도 오류를 413으로 전송할 수 있게 배출합니다.
    cancel() { cleanup(); req.resume(); },
  });
}

export function createRagHandler(env = process.env, options = {}) {
  const handle = createRagFetchHandler(env, { cryptoImpl: webcrypto, ...options });
  return async function handleRag(req, res, url) {
    if (url.pathname !== "/api/rag" && !url.pathname.startsWith("/api/rag/")) return false;
    const target = new URL(url);
    if (req.socket.encrypted || req.headers["x-forwarded-proto"] === "https") target.protocol = "https:";
    const controller = new AbortController();
    const aborted = () => controller.abort();
    req.once("aborted", aborted);
    let request;
    try {
      const body = req.method === "POST" ? requestBody(req) : undefined;
      request = new Request(target, { method: req.method, headers: req.headers, ...(body ? { body, duplex: "half" } : {}), signal: controller.signal });
      const response = await handle(request);
      if (!response) return false;
      if (res.destroyed) return true;
      res.statusCode = response.status;
      for (const [key, value] of response.headers) res.setHeader(key, value);
      const cookies = response.headers.getSetCookie?.();
      if (cookies?.length) res.setHeader("set-cookie", cookies);
      res.end(new Uint8Array(await response.arrayBuffer()));
      return true;
    } finally {
      req.removeListener("aborted", aborted);
      // 검증 단계에서 본문을 읽지 않은 경우도 Node 연결을 정상적으로 정리합니다.
      if (!req.readableEnded) {
        if (request?.body && !request.body.locked) await request.body.cancel().catch(() => {});
        req.resume();
      }
    }
  };
}