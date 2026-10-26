// node hosting/build.mjs 후 실행한다. 실제 배포와 동일한 단일 ESM을 불러온다.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import worker from "./dist/server/index.js";

const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
const request = (path, options) => new Request("https://public.example" + path, options);

test("배포 ESM의 HTML은 기존 한화 빌드와 완전히 동일", async () => {
  const response = await worker.fetch(request("/"), {});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), html);
  assert.match(html, /SAMPLE/);
  assert.match(html, /한화엔진/);
});
test("배포 ESM에서 LLM 키 미설정 상태를 올바르게 반환", async () => {
  const response = await worker.fetch(request("/api/ai/status"), {});
  assert.deepEqual(await response.json(), { enabled: false, model: null });
});
test("배포 ESM에서 실제 RAG 공통코어 설정 계약 유지", async () => {
  const offline = await worker.fetch(request("/api/rag/status"), {});
  assert.equal((await offline.json()).enabled, false);
  const configured = await worker.fetch(request("/api/rag/status"), { RAG_ORIGIN: "https://gateway.example", RAG_GATEWAY_TOKEN: "test-only-worker-secret-0123456789abcdef" });
  const status = await configured.json();
  assert.equal(status.enabled, true);
  assert.deepEqual(status.models, ["qwen3:8b", "gemma3:4b", "llama3.1:8b"]);
});
test("배포 ESM의 비밀 환경변수가 HTML로 전달되지 않음", async () => {
  const secret = "test-only-secret-not-in-html-0123456789abcdef";
  const response = await worker.fetch(request("/"), { ANTHROPIC_API_KEY: secret, RAG_GATEWAY_TOKEN: secret, RAG_ORIGIN: "https://private-gateway.example" });
  const body = await response.text();
  for (const value of [secret, "https://private-gateway.example", "RAG_GATEWAY_TOKEN", "ANTHROPIC_API_KEY"]) assert.ok(!body.includes(value));
});
test("배포 ESM의 알 수 없는 API는 HTML로 대체되지 않음", async () => {
  const response = await worker.fetch(request("/api/not-real"), {});
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
