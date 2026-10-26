import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac, webcrypto } from "node:crypto";
import { test } from "node:test";
import { createAppServer } from "../server/index.mjs";
import { createRagFetchHandler } from "../server/rag-fetch.mjs";

const TOKEN = "test-only-gateway-token-0123456789abcdef";
const JOB = "cb87b92d-3822-4d2a-8d05-7cc553e803ba";
const QUESTION = { question: "수량은?", model: "gemma3:4b", order_id: 1101 };
const ANSWER = { status: "answered", question: "수량은?", answer: "발주 수량은 20개입니다. [E1]", message: "검색 근거로 답변을 생성했습니다.", generation_model: "gemma3:4b", model_called: true, sources: [{ evidence_id: "E1", source: { source_refs: ["purchase_orders:1101"] } }], citation_check: "valid_ids_only" };
const DATASET_ID = "6631d159-1225-49f8-b4b5-a5b81f6d63b3";
const REVISION = "a".repeat(64);
const DATASET = { id: DATASET_ID, revision: REVISION };
const SESSION = "S".repeat(43);
const DATASET_STATUS = { dataset_id: DATASET_ID, revision: REVISION, status: "indexing", row_count: 1, chunk_count: 1 };
const SNAPSHOT = {
  schema_version: 1, client_revision: "upload-123",
  meta: { asOf: "2026-10-26", isSample: false, label: "SAMPLE + 업로드 데이터", sources: { suppliers: "업체목록.csv" }, uploaded: ["suppliers"] },
  data: { suppliers: [{ supplierId: "SUP-WEB-001", name: "웹 전용 업체", items: [], evalHistory: [] }], items: [], purchaseOrders: [], contracts: [], inventory: [], bom: [], materialPrices: [], fxRates: [], laborWages: [], competitorSupply: [], industryNews: [] },
};

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return "http://127.0.0.1:" + server.address().port;
}

async function setup(t, handler = (_req, res) => json(res, 202, { job_id: JOB, status: "running" }), options = {}) {
  const gateway = await listen(t, createServer(handler));
  const site = await listen(t, createAppServer({ env: { RAG_ORIGIN: gateway, RAG_GATEWAY_TOKEN: TOKEN }, ragOptions: options }));
  return { site, gateway };
}

function submit(site, body = QUESTION, headers = {}) {
  return fetch(site + "/api/rag/jobs", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

function upload(site, body = SNAPSHOT, headers = {}) {
  return fetch(site + "/api/rag/datasets", { method: "POST", headers: { "content-type": "application/json", "x-rag-session": SESSION, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

test("status reports configuration without contacting gateway or exposing secrets", async (t) => {
  let requests = 0;
  const { site, gateway } = await setup(t, () => { requests++; });
  const response = await fetch(site + "/api/rag/status");
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body, { enabled: true, models: ["qwen3:8b", "gemma3:4b", "llama3.1:8b"] });
  assert.equal(requests, 0);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.ok(!JSON.stringify(body).includes(TOKEN));
  assert.ok(!JSON.stringify(body).includes(gateway));
});

test("unconfigured or unsafe origins disable only RAG and do not disclose configuration", async (t) => {
  for (const env of [
    {},
    { RAG_ORIGIN: "http://example.com", RAG_GATEWAY_TOKEN: TOKEN },
    { RAG_ORIGIN: "https://user:pass@example.com", RAG_GATEWAY_TOKEN: TOKEN },
    { RAG_ORIGIN: "https://example.com/internal", RAG_GATEWAY_TOKEN: TOKEN },
    { RAG_ORIGIN: "https://example.com/?token=secret", RAG_GATEWAY_TOKEN: TOKEN },
    { RAG_ORIGIN: "https://example.com/#secret", RAG_GATEWAY_TOKEN: TOKEN },
    { RAG_ORIGIN: "https://example.com", RAG_GATEWAY_TOKEN: "short" },
    { RAG_ORIGIN: "https://example.com", RAG_GATEWAY_TOKEN: TOKEN + "\n" },
  ]) {
    const site = await listen(t, createAppServer({ env }));
    const response = await fetch(site + "/api/rag/status");
    const body = await response.json();
    assert.equal(body.enabled, false);
    assert.ok(body.message);
    assert.ok(!JSON.stringify(body).includes("example.com"));
    const rejected = await submit(site);
    assert.equal(rejected.status, 503);
    assert.match((await rejected.json()).error, /설정/);
    assert.equal((await fetch(site + "/api/ai/status")).status, 200);
  }
});

test("HTTPS and local IPv6 origins are accepted", async (t) => {
  for (const origin of ["https://example.com", "http://localhost:8400", "http://[::1]:8400"]) {
    const site = await listen(t, createAppServer({ env: { RAG_ORIGIN: origin, RAG_GATEWAY_TOKEN: TOKEN } }));
    assert.equal((await (await fetch(site + "/api/rag/status")).json()).enabled, true);
  }
});

test("submit and poll retain signed cookie visitor and replace browser credentials", async (t) => {
  const requests = [];
  const { site } = await setup(t, async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    requests.push({ url: req.url, method: req.method, headers: req.headers, body: raw && JSON.parse(raw) });
    json(res, req.method === "POST" ? 202 : 200, { job_id: JOB, status: req.method === "POST" ? "running" : "succeeded", ...(req.method === "GET" ? { result: ANSWER, internal: "should not relay" } : {}) });
  });
  const posted = await submit(site, { ...QUESTION, top_k: 3, supplier_id: 22, part_id: 33, document_type: "order" }, { authorization: "Bearer browser-supplied", "x-rag-visitor": "A".repeat(43) });
  assert.equal(posted.status, 202);
  assert.equal(posted.headers.get("location"), "/api/rag/jobs/" + JOB);
  assert.deepEqual(await posted.json(), { job_id: JOB, status: "running" });
  const setCookie = posted.headers.get("set-cookie");
  assert.match(setCookie, /^rag_visitor=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43};/);
  assert.match(setCookie, /HttpOnly; SameSite=Lax/);
  assert.match(setCookie, /Path=\/api\/rag/);
  const polled = await fetch(site + "/api/rag/jobs/" + JOB, { headers: { cookie: setCookie.split(";", 1)[0], "x-rag-visitor": "B".repeat(43) } });
  assert.equal(polled.status, 200);
  assert.equal(polled.headers.get("set-cookie"), null);
  assert.deepEqual(await polled.json(), { job_id: JOB, status: "succeeded", result: ANSWER });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers.authorization, "Bearer " + TOKEN);
  assert.equal(requests[1].headers.authorization, "Bearer " + TOKEN);
  assert.equal(requests[0].headers["x-rag-visitor"], requests[1].headers["x-rag-visitor"]);
  assert.match(requests[0].headers["x-rag-visitor"], /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(requests[0].headers["x-rag-visitor"], "A".repeat(43));
  assert.equal(requests[0].headers.cookie, undefined);
  assert.deepEqual(requests[0].body, { ...QUESTION, top_k: 3, supplier_id: 22, part_id: 33, document_type: "order" });
  assert.equal(requests[1].url, "/jobs/" + JOB);
});

test("separate visitors and tampered cookies cannot retrieve another visitor's job", async (t) => {
  let owner;
  const { site } = await setup(t, (req, res) => {
    if (req.method === "POST") { owner = req.headers["x-rag-visitor"]; json(res, 202, { job_id: JOB, status: "running" }); }
    else if (req.headers["x-rag-visitor"] === owner) json(res, 200, { job_id: JOB, status: "succeeded", result: ANSWER });
    else json(res, 404, { message: "not owned" });
  });
  const posted = await submit(site);
  const cookie = posted.headers.get("set-cookie").split(";", 1)[0];
  const stranger = await fetch(site + "/api/rag/jobs/" + JOB, { headers: { "x-rag-visitor": owner } });
  assert.equal(stranger.status, 404);
  assert.ok(!JSON.stringify(await stranger.json()).includes(ANSWER.answer));
  const damaged = cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A");
  const tampered = await fetch(site + "/api/rag/jobs/" + JOB, { headers: { cookie: damaged } });
  assert.equal(tampered.status, 404);
  assert.ok(tampered.headers.get("set-cookie"));
  const duplicate = await fetch(site + "/api/rag/jobs/" + JOB, { headers: { cookie: cookie + "; " + cookie } });
  assert.equal(duplicate.status, 404);
  assert.equal((await fetch(site + "/api/rag/jobs/" + JOB, { headers: { cookie } })).status, 200);
});

test("HTTPS proxy requests receive Secure cookies", async (t) => {
  const { site } = await setup(t);
  const response = await submit(site, QUESTION, { "x-forwarded-proto": "https" });
  assert.match(response.headers.get("set-cookie"), /; Secure$/);
});

test("invalid field types, ranges and extra fields never reach gateway", async (t) => {
  let requests = 0;
  const { site } = await setup(t, (_req, res) => { requests++; json(res, 500, {}); });
  const invalid = [null, [], "null", { ...QUESTION, question: " " }, { ...QUESTION, question: "가".repeat(1001) }, { ...QUESTION, model: "arbitrary" }, { ...QUESTION, top_k: "3" }, { ...QUESTION, top_k: 11 }, { ...QUESTION, order_id: "1101" }, { ...QUESTION, supplier_id: true }, { ...QUESTION, part_id: 0 }, { ...QUESTION, part_id: 1.5 }, { ...QUESTION, part_id: Number.MAX_SAFE_INTEGER + 1 }, { ...QUESTION, document_type: "unknown" }, { ...QUESTION, url: "https://attacker.example" }, { ...QUESTION, __protoField: {} }];
  for (const body of invalid) {
    const response = await submit(site, body);
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.match((await response.json()).error, /형식|범위/);
  }
  assert.equal(requests, 0);
});

test("invalid JSON, media type and oversized bodies have explicit errors", async (t) => {
  let requests = 0;
  const { site } = await setup(t, (_req, res) => { requests++; json(res, 500, {}); });
  assert.equal((await submit(site, "{")).status, 400);
  assert.equal((await submit(site, QUESTION, { "content-type": "text/plain" })).status, 415);
  assert.equal((await submit(site, { ...QUESTION, question: "가".repeat(4000) })).status, 413);
  const streamed = await fetch(site + "/api/rag/jobs", {
    method: "POST", headers: { "content-type": "application/json" }, duplex: "half",
    body: (async function* () { yield "{\"question\":\""; yield "a".repeat(9000); yield "\"}"; })(),
  });
  assert.equal(streamed.status, 413);
  assert.equal(requests, 0);
});

test("invalid job IDs, paths, methods and query strings are not forwarded", async (t) => {
  let requests = 0;
  const { site } = await setup(t, (_req, res) => { requests++; json(res, 500, {}); });
  for (const path of ["/api/rag/jobs/not-a-uuid", "/api/rag/jobs/" + JOB.toUpperCase(), "/api/rag/jobs/" + JOB + "?origin=secret"]) {
    assert.equal((await fetch(site + path)).status, 400);
  }
  assert.equal((await fetch(site + "/api/rag/missing")).status, 404);
  const wrongMethod = await fetch(site + "/api/rag/jobs");
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
  assert.equal((await fetch(site + "/api/rag/status", { method: "POST" })).status, 405);
  assert.equal(requests, 0);
});

test("quota response preserves bounded Retry-After and redacts gateway body and headers", async (t) => {
  const { site, gateway } = await setup(t, (_req, res) => json(res, 429, { message: TOKEN + " private address" }, { "retry-after": "42", "set-cookie": "gateway-secret=yes", location: "https://private.example" }));
  const response = await submit(site);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "42");
  assert.ok(!response.headers.get("set-cookie").includes("gateway-secret"));
  assert.equal(response.headers.get("location"), null);
  const text = await response.text();
  assert.ok(!text.includes(TOKEN));
  assert.ok(!text.includes(gateway));
  assert.match(text, /한도/);
});

test("redirects are never followed or exposed", async (t) => {
  let targetRequests = 0;
  const target = await listen(t, createServer((_req, res) => { targetRequests++; json(res, 202, { job_id: JOB, status: "running" }); }));
  const { site } = await setup(t, (_req, res) => json(res, 307, { message: TOKEN }, { location: target + "/" + TOKEN }));
  const response = await submit(site);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("location"), null);
  assert.ok(!(await response.text()).includes(TOKEN));
  assert.equal(targetRequests, 0);
});

test("gateway authorization and server errors become safe service errors", async (t) => {
  for (const status of [401, 403, 500, 503, 504]) {
    const { site } = await setup(t, (_req, res) => json(res, status, { message: TOKEN, error: "http://private-backend" }));
    const response = await submit(site);
    assert.equal(response.status, [503, 504].includes(status) ? status : 502);
    const text = await response.text();
    assert.ok(!text.includes(TOKEN));
    assert.ok(!text.includes("private-backend"));
  }
});

test("network errors and request timeouts do not expose private addresses", async (t) => {
  const site = await listen(t, createAppServer({ env: { RAG_ORIGIN: "http://127.0.0.1:1", RAG_GATEWAY_TOKEN: TOKEN } }));
  const unavailable = await submit(site);
  assert.equal(unavailable.status, 503);
  assert.ok(!(await unavailable.text()).includes("127.0.0.1"));
  const delayed = await setup(t, () => {}, { timeoutMs: 30 });
  const timedOut = await submit(delayed.site);
  assert.equal(timedOut.status, 504);
  assert.match((await timedOut.json()).error, /초과/);
});

test("invalid and excessive gateway responses are rejected", async (t) => {
  const responses = [
    [202, { job_id: "not-an-id", status: "running" }],
    [202, { job_id: JOB, status: "succeeded", result: ANSWER }],
    [200, { job_id: JOB, status: "running" }],
    [202, { job_id: JOB, status: "running", secret: "x".repeat(2000) }],
  ];
  for (const [status, data] of responses) {
    const { site } = await setup(t, (_req, res) => json(res, status, data), { maxResponseBytes: 1024 });
    assert.equal((await submit(site)).status, 502);
  }
  const malformed = await setup(t, (_req, res) => { res.writeHead(202); res.end("not JSON " + TOKEN); });
  const response = await submit(malformed.site);
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(TOKEN));
});

test("failed jobs redact messages and successful results require the result contract", async (t) => {
  const { site } = await setup(t, (_req, res) => json(res, 200, { job_id: JOB, status: "failed", error_status: 504, message: TOKEN }));
  const failed = await fetch(site + "/api/rag/jobs/" + JOB);
  const body = await failed.json();
  assert.equal(body.status, "failed");
  assert.equal(body.error_status, 504);
  assert.match(body.message, /초과/);
  assert.ok(!JSON.stringify(body).includes(TOKEN));
  for (const result of [null, {}, { ...ANSWER, sources: "not-an-array" }, { ...ANSWER, answer: 42 }]) {
    const invalid = await setup(t, (_req, res) => json(res, 200, { job_id: JOB, status: "succeeded", result }));
    assert.equal((await fetch(invalid.site + "/api/rag/jobs/" + JOB)).status, 502);
  }
});

test("web dataset upload, status, question, poll and deletion share one scoped owner", async (t) => {
  const requests = [];
  let owner;
  let deleted = false;
  const webAnswer = { ...ANSWER, dataset: DATASET, retrieval_method: "web_snapshot_vector", sources: [{ evidence_id: "E1", source: { source_refs: ["웹업로드:suppliers:SUP-WEB-001"], dataset_id: DATASET_ID, revision: REVISION } }] };
  const { site } = await setup(t, async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
    if (req.method === "POST" && req.url === "/datasets") {
      owner = req.headers["x-rag-visitor"];
      json(res, 202, { ...DATASET_STATUS, internal_path: TOKEN });
    } else if (req.headers["x-rag-visitor"] !== owner || deleted) json(res, 404, { message: TOKEN });
    else if (req.method === "DELETE") { deleted = true; json(res, 200, { deleted: true, owner: TOKEN }); }
    else if (req.url.startsWith("/datasets/")) json(res, 200, { ...DATASET_STATUS, status: "ready" });
    else if (req.method === "POST") json(res, 202, { job_id: JOB, status: "running", dataset: DATASET });
    else json(res, 200, { job_id: JOB, status: "succeeded", dataset: DATASET, result: webAnswer });
  });
  const posted = await upload(site, SNAPSHOT, { authorization: "Bearer client", "x-rag-visitor": "A".repeat(43) });
  assert.equal(posted.status, 202);
  assert.equal(posted.headers.get("location"), "/api/rag/datasets/" + DATASET_ID);
  assert.deepEqual(await posted.json(), DATASET_STATUS);
  const cookie = posted.headers.get("set-cookie").split(";", 1)[0];
  const headers = { cookie, "x-rag-session": SESSION };
  const status = await fetch(site + "/api/rag/datasets/" + DATASET_ID, { headers });
  assert.deepEqual(await status.json(), { ...DATASET_STATUS, status: "ready" });
  const submitted = await submit(site, { question: "웹 전용 업체 이름은?", model: "qwen3:8b", dataset: DATASET }, headers);
  assert.equal(submitted.status, 202);
  assert.deepEqual(await submitted.json(), { job_id: JOB, status: "running", dataset: DATASET });
  const result = await fetch(site + "/api/rag/jobs/" + JOB, { headers });
  assert.deepEqual(await result.json(), { job_id: JOB, status: "succeeded", dataset: DATASET, result: webAnswer });
  const removed = await fetch(site + "/api/rag/datasets/" + DATASET_ID, { method: "DELETE", headers });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { deleted: true });
  assert.equal((await fetch(site + "/api/rag/jobs/" + JOB, { headers })).status, 404);
  assert.deepEqual(requests[0].body, SNAPSHOT);
  assert.equal(new Set(requests.map((request) => request.headers["x-rag-visitor"])).size, 1);
  const rawVisitor = cookie.slice("rag_visitor=".length).split(".", 1)[0];
  assert.notEqual(owner, rawVisitor);
  assert.notEqual(owner, SESSION);
  assert.notEqual(owner, "A".repeat(43));
  for (const request of requests) {
    assert.equal(request.headers.authorization, "Bearer " + TOKEN);
    assert.equal(request.headers["x-rag-session"], undefined);
    assert.equal(request.headers.cookie, undefined);
    assert.match(request.headers["x-rag-visitor"], /^[A-Za-z0-9_-]{43}$/);
  }
});

test("sessions isolate datasets and jobs even when the browser cookie is shared", async (t) => {
  let owner;
  const { site } = await setup(t, (req, res) => {
    if (req.url === "/datasets") { owner = req.headers["x-rag-visitor"]; json(res, 202, DATASET_STATUS); }
    else if (owner !== req.headers["x-rag-visitor"]) json(res, 404, { message: "not owned" });
    else if (req.method === "DELETE") json(res, 200, { deleted: true });
    else if (req.url.startsWith("/datasets/")) json(res, 200, { ...DATASET_STATUS, status: "ready" });
    else json(res, 200, { job_id: JOB, status: "running", dataset: DATASET });
  });
  const response = await upload(site);
  const cookie = response.headers.get("set-cookie").split(";", 1)[0];
  const foreign = { cookie, "x-rag-session": "B".repeat(43), "x-rag-visitor": owner };
  assert.equal((await fetch(site + "/api/rag/datasets/" + DATASET_ID, { headers: foreign })).status, 404);
  assert.equal((await fetch(site + "/api/rag/datasets/" + DATASET_ID, { method: "DELETE", headers: foreign })).status, 404);
  assert.equal((await fetch(site + "/api/rag/jobs/" + JOB, { headers: foreign })).status, 404);
  assert.equal((await fetch(site + "/api/rag/jobs/" + JOB, { headers: { cookie } })).status, 404);
  assert.equal((await fetch(site + "/api/rag/datasets/" + DATASET_ID, { headers: { cookie, "x-rag-session": SESSION } })).status, 200);
});

test("dataset routes and dataset jobs require a valid session capability", async (t) => {
  let requests = 0;
  const { site } = await setup(t, (_req, res) => { requests++; json(res, 500, {}); });
  const headers = { "content-type": "application/json" };
  assert.equal((await fetch(site + "/api/rag/datasets", { method: "POST", headers, body: JSON.stringify(SNAPSHOT) })).status, 400);
  assert.equal((await fetch(site + "/api/rag/datasets/" + DATASET_ID)).status, 400);
  assert.equal((await fetch(site + "/api/rag/datasets/" + DATASET_ID, { method: "DELETE" })).status, 400);
  assert.equal((await submit(site, { question: "업체 이름은?", model: "qwen3:8b", dataset: DATASET })).status, 400);
  for (const session of ["short", "S".repeat(44), "S".repeat(42) + "+", SESSION + "," + SESSION]) {
    assert.equal((await upload(site, SNAPSHOT, { "x-rag-session": session })).status, 400);
    assert.equal((await submit(site, QUESTION, { "x-rag-session": session })).status, 400);
    assert.equal((await fetch(site + "/api/rag/jobs/" + JOB, { headers: { "x-rag-session": session } })).status, 400);
  }
  assert.equal(requests, 0);
});

test("legacy database jobs also retain their optional scoped session", async (t) => {
  const owners = [];
  const { site } = await setup(t, (req, res) => {
    owners.push(req.headers["x-rag-visitor"]);
    json(res, req.method === "POST" ? 202 : 200, { job_id: JOB, status: req.method === "POST" ? "running" : "succeeded", ...(req.method === "GET" ? { result: ANSWER } : {}) });
  });
  const created = await submit(site, QUESTION, { "x-rag-session": SESSION });
  const cookie = created.headers.get("set-cookie").split(";", 1)[0];
  const polled = await fetch(site + "/api/rag/jobs/" + JOB, { headers: { cookie, "x-rag-session": SESSION } });
  assert.equal(polled.status, 200);
  assert.deepEqual((await polled.json()).result, ANSWER);
  assert.equal(owners[0], owners[1]);
});

test("snapshot envelope, table shapes and session/owner injections are validated", async (t) => {
  let requests = 0;
  const { site } = await setup(t, (_req, res) => { requests++; json(res, 500, {}); });
  const invalid = [
    null, [], { ...SNAPSHOT, schema_version: "1" }, { ...SNAPSHOT, client_revision: "" }, { ...SNAPSHOT, client_revision: "r".repeat(129) },
    { ...SNAPSHOT, session: SESSION }, { ...SNAPSHOT, owner: "attacker" },
    { ...SNAPSHOT, meta: { ...SNAPSHOT.meta, owner: "attacker" } }, { ...SNAPSHOT, meta: { ...SNAPSHOT.meta, isSample: "false" } },
    { ...SNAPSHOT, meta: { ...SNAPSHOT.meta, sources: { unknown: "file" } } }, { ...SNAPSHOT, meta: { ...SNAPSHOT.meta, uploaded: ["suppliers", "suppliers"] } },
    { ...SNAPSHOT, data: {} }, { ...SNAPSHOT, data: { ...SNAPSHOT.data, unknown: [] } },
    { ...SNAPSHOT, data: { ...SNAPSHOT.data, suppliers: "not-an-array" } }, { ...SNAPSHOT, data: { ...SNAPSHOT.data, suppliers: [null] } },
  ];
  for (const value of invalid) assert.equal((await upload(site, value)).status, 422, JSON.stringify(value));
  assert.equal((await upload(site, "{")).status, 400);
  assert.equal((await upload(site, SNAPSHOT, { "content-type": "text/plain" })).status, 415);
  assert.equal((await upload(site, { ...SNAPSHOT, data: { ...SNAPSHOT.data, suppliers: Array.from({ length: 2001 }, () => ({})) } })).status, 413);
  assert.equal(requests, 0);
});

test("only snapshot uploads accept bodies beyond 8 KiB and still enforce 2 MiB UTF-8 bytes", async (t) => {
  let requests = 0;
  const { site } = await setup(t, (_req, res) => { requests++; json(res, 202, DATASET_STATUS); });
  const large = { ...SNAPSHOT, data: { ...SNAPSHOT.data, suppliers: [{ ...SNAPSHOT.data.suppliers[0], name: "가".repeat(4000) }] } };
  assert.equal((await upload(site, large)).status, 202);
  assert.equal((await submit(site, { ...QUESTION, question: "가".repeat(4000) }, { "x-rag-session": SESSION })).status, 413);
  const excessive = { ...SNAPSHOT, data: { ...SNAPSHOT.data, suppliers: [{ name: "가".repeat(710_000) }] } };
  assert.equal((await upload(site, excessive)).status, 413);
  const streamed = await fetch(site + "/api/rag/datasets", {
    method: "POST", headers: { "content-type": "application/json", "x-rag-session": SESSION }, duplex: "half",
    body: (async function* () { yield "{\"data\":\""; for (let i = 0; i < 33; i++) yield "x".repeat(65536); yield "\"}"; })(),
  });
  assert.equal(streamed.status, 413);
  assert.equal(requests, 1);
});

test("dataset references reject malformed identities and all database-filter combinations", async (t) => {
  let requests = 0;
  const { site } = await setup(t, (_req, res) => { requests++; json(res, 500, {}); });
  const question = { question: "웹 업체 이름은?", model: "qwen3:8b", dataset: DATASET };
  for (const dataset of [null, DATASET_ID, { id: "bad", revision: REVISION }, { id: DATASET_ID, revision: "bad" }, { id: DATASET_ID, revision: REVISION.toUpperCase() }, { ...DATASET, owner: "attacker" }]) {
    assert.equal((await submit(site, { ...question, dataset }, { "x-rag-session": SESSION })).status, 422);
  }
  for (const field of ["order_id", "supplier_id", "part_id", "document_type"]) {
    assert.equal((await submit(site, { ...question, [field]: null }, { "x-rag-session": SESSION })).status, 422);
    assert.equal((await submit(site, { ...question, [field]: field === "document_type" ? "order" : 1 }, { "x-rag-session": SESSION })).status, 422);
  }
  assert.equal((await submit(site, { ...question, owner: "attacker" }, { "x-rag-session": SESSION })).status, 422);
  assert.equal(requests, 0);
});

test("dataset paths, query strings and methods cannot change the fixed upstream route", async (t) => {
  let requests = 0;
  const { site } = await setup(t, (_req, res) => { requests++; json(res, 500, {}); });
  const headers = { "x-rag-session": SESSION };
  assert.equal((await fetch(site + "/api/rag/datasets/not-an-id", { headers })).status, 400);
  assert.equal((await fetch(site + "/api/rag/datasets/" + DATASET_ID + "?owner=another", { headers })).status, 400);
  assert.equal((await fetch(site + "/api/rag/datasets", { headers })).status, 405);
  const wrong = await fetch(site + "/api/rag/datasets/" + DATASET_ID, { method: "POST", headers });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get("allow"), "GET, DELETE");
  assert.equal(requests, 0);
});

test("dataset responses are bounded, checked and stripped of internal messages", async (t) => {
  for (const value of [
    { ...DATASET_STATUS, dataset_id: "bad" }, { ...DATASET_STATUS, revision: "bad" }, { ...DATASET_STATUS, status: "deleted" },
    { ...DATASET_STATUS, row_count: -1 }, { ...DATASET_STATUS, row_count: 2001 }, { ...DATASET_STATUS, chunk_count: 2049 },
  ]) {
    const { site } = await setup(t, (_req, res) => json(res, 202, value));
    assert.equal((await upload(site)).status, 502);
  }
  const { site } = await setup(t, (req, res) => json(res, req.method === "POST" ? 202 : 200, { ...DATASET_STATUS, status: "failed", message: TOKEN + " /private/path", token: TOKEN }));
  const response = await upload(site);
  const body = await response.json();
  assert.equal(body.status, "failed");
  assert.match(body.message, /검색 준비/);
  assert.ok(!JSON.stringify(body).includes(TOKEN));
  assert.equal(Object.hasOwn(body, "token"), false);
  const badDelete = await fetch(site + "/api/rag/datasets/" + DATASET_ID, { method: "DELETE", headers: { "x-rag-session": SESSION } });
  assert.equal(badDelete.status, 502);
  const wrongId = "1231d159-1225-49f8-b4b5-a5b81f6d63b3";
  assert.equal((await fetch(site + "/api/rag/datasets/" + wrongId, { headers: { "x-rag-session": SESSION } })).status, 502);
});

test("dataset job identity must survive every job and successful result envelope", async (t) => {
  const bad = [
    { job_id: JOB, status: "running" },
    { job_id: JOB, status: "running", dataset: { ...DATASET, revision: "b".repeat(64) } },
    { job_id: JOB, status: "running", dataset: { ...DATASET, owner: TOKEN } },
  ];
  for (const responseBody of bad) {
    const { site } = await setup(t, (_req, res) => json(res, 202, responseBody));
    assert.equal((await submit(site, { question: "웹 업체 이름은?", model: "qwen3:8b", dataset: DATASET }, { "x-rag-session": SESSION })).status, 502);
  }
  for (const resultDataset of [undefined, { ...DATASET, revision: "b".repeat(64) }, { ...DATASET, owner: TOKEN }]) {
    const { site } = await setup(t, (_req, res) => json(res, 200, { job_id: JOB, status: "succeeded", dataset: DATASET, result: { ...ANSWER, dataset: resultDataset } }));
    assert.equal((await fetch(site + "/api/rag/jobs/" + JOB, { headers: { "x-rag-session": SESSION } })).status, 502);
  }
  const noSession = await setup(t, (_req, res) => json(res, 200, { job_id: JOB, status: "running", dataset: DATASET }));
  assert.equal((await fetch(noSession.site + "/api/rag/jobs/" + JOB)).status, 502);
  const unexpectedDataset = await setup(t, (_req, res) => json(res, 202, { job_id: JOB, status: "running", dataset: DATASET }));
  assert.equal((await submit(unexpectedDataset.site, QUESTION, { "x-rag-session": SESSION })).status, 502);
});

test("dataset uploads use existing redacted quota, redirect and timeout handling", async (t) => {
  const limited = await setup(t, (_req, res) => json(res, 429, { message: TOKEN }, { "retry-after": "7" }));
  const quota = await upload(limited.site);
  assert.equal(quota.status, 429);
  assert.equal(quota.headers.get("retry-after"), "7");
  assert.ok(!(await quota.text()).includes(TOKEN));
  const redirect = await setup(t, (_req, res) => json(res, 307, { message: TOKEN }, { location: "https://private.example/" + TOKEN }));
  const redirected = await upload(redirect.site);
  assert.equal(redirected.status, 502);
  assert.equal(redirected.headers.get("location"), null);
  const delayed = await setup(t, () => {}, { timeoutMs: 30 });
  assert.equal((await upload(delayed.site)).status, 504);
});

function core(fetchImpl, options = {}) {
  return createRagFetchHandler({ RAG_ORIGIN: "https://gateway.example", RAG_GATEWAY_TOKEN: TOKEN }, { fetchImpl, cryptoImpl: webcrypto, ...options });
}

function coreRequest(path, body, headers = {}, method = body === undefined ? "GET" : "POST") {
  return new Request("https://site.example" + path, {
    method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

function oldCookie(visitor) {
  return "rag_visitor=" + visitor + "." + createHmac("sha256", TOKEN).update("hanwha-rag-visitor-v1:" + visitor).digest("base64url");
}

test("Fetch core returns Response for API and null for unrelated routes without network", async () => {
  let requests = 0;
  const handle = core(async () => { requests++; throw new Error("must not fetch"); });
  assert.equal(await handle(coreRequest("/")), null);
  assert.equal(await handle(coreRequest("/api/ai/status")), null);
  const status = await handle(coreRequest("/api/rag/status"));
  assert.ok(status instanceof Response);
  assert.deepEqual(await status.json(), { enabled: true, models: ["qwen3:8b", "gemma3:4b", "llama3.1:8b"] });
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.equal(status.headers.get("set-cookie"), null);
  const unavailable = createRagFetchHandler({}, { cryptoImpl: webcrypto });
  assert.equal((await (await unavailable(coreRequest("/api/rag/status"))).json()).enabled, false);
  assert.equal((await unavailable(coreRequest("/api/rag/jobs", QUESTION))).status, 503);
  assert.equal(requests, 0);
});

test("Fetch core WebCrypto accepts existing Node cookies and preserves scoped HMAC bytes", async () => {
  const visitor = "V".repeat(43);
  const received = [];
  const handle = core(async (url, init) => { received.push({ url, init }); return Response.json({ job_id: JOB, status: "running" }, { status: 202 }); });
  const response = await handle(coreRequest("/api/rag/jobs", QUESTION, { cookie: oldCookie(visitor), "x-rag-session": SESSION, authorization: "Bearer browser", "x-rag-visitor": "X".repeat(43) }));
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("set-cookie"), null);
  const expected = createHmac("sha256", TOKEN).update("hanwha-rag-session-v1:" + visitor + ":" + SESSION).digest("base64url");
  assert.equal(received[0].init.headers["x-rag-visitor"], expected);
  assert.equal(received[0].init.headers.authorization, "Bearer " + TOKEN);
  assert.equal(received[0].init.headers.cookie, undefined);
  assert.equal(received[0].init.headers["x-rag-session"], undefined);
  assert.equal(received[0].url, "https://gateway.example/jobs");
  assert.equal(received[0].init.redirect, "manual");
});

test("Fetch core new cookies remain verifiable by Node with HTTPS-only Secure", async () => {
  const handle = core(async () => Response.json({ job_id: JOB, status: "running" }, { status: 202 }));
  const response = await handle(coreRequest("/api/rag/jobs", QUESTION));
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);
  const [visitor, signed] = cookie.split(";", 1)[0].slice("rag_visitor=".length).split(".");
  assert.equal(signed, createHmac("sha256", TOKEN).update("hanwha-rag-visitor-v1:" + visitor).digest("base64url"));
  const plain = new Request("http://localhost/api/rag/jobs", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-proto": "https" }, body: JSON.stringify(QUESTION) });
  assert.ok(!(await handle(plain)).headers.get("set-cookie").includes("; Secure"));
});

test("Fetch core rejects duplicate, tampered and noncanonical base64 signatures", async () => {
  const visitor = "V".repeat(43);
  const cookie = oldCookie(visitor);
  const signed = cookie.split(".")[1];
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const index = alphabet.indexOf(signed.at(-1));
  const noncanonical = signed.slice(0, -1) + alphabet[index + 1];
  // Same decoded signature bytes, different padding bits: the old Node string comparison rejected this too.
  assert.deepEqual(Buffer.from(signed, "base64url"), Buffer.from(noncanonical, "base64url"));
  const owners = [];
  const handle = core(async (_url, init) => { owners.push(init.headers["x-rag-visitor"]); return Response.json({ job_id: JOB, status: "running" }, { status: 202 }); });
  for (const invalid of [cookie + "; " + cookie, "rag_visitor=" + visitor + "." + noncanonical, cookie + ".extra"]) {
    const response = await handle(coreRequest("/api/rag/jobs", QUESTION, { cookie: invalid }));
    assert.equal(response.status, 202);
    assert.ok(response.headers.get("set-cookie"));
    assert.notEqual(owners.at(-1), visitor);
  }
});

test("Fetch core keeps upload/status/job/poll/delete identity and session contracts", async () => {
  const calls = [];
  const handle = core(async (url, init) => {
    calls.push({ path: new URL(url).pathname, method: init.method, owner: init.headers["x-rag-visitor"] });
    if (init.method === "DELETE") return Response.json({ deleted: true });
    if (url.endsWith("/datasets")) return Response.json(DATASET_STATUS, { status: 202 });
    if (url.includes("/datasets/")) return Response.json({ ...DATASET_STATUS, status: "ready" });
    if (init.method === "POST") return Response.json({ job_id: JOB, status: "running", dataset: DATASET }, { status: 202 });
    return Response.json({ job_id: JOB, status: "succeeded", dataset: DATASET, result: { ...ANSWER, dataset: DATASET } });
  });
  const headers = { cookie: oldCookie("V".repeat(43)), "x-rag-session": SESSION };
  const created = await handle(coreRequest("/api/rag/datasets", SNAPSHOT, headers));
  assert.equal(created.status, 202);
  assert.deepEqual(await created.json(), DATASET_STATUS);
  assert.equal((await handle(coreRequest("/api/rag/datasets/" + DATASET_ID, undefined, headers))).status, 200);
  const submitted = await handle(coreRequest("/api/rag/jobs", { question: "업체 이름", model: "qwen3:8b", dataset: DATASET }, headers));
  assert.equal(submitted.status, 202);
  const polled = await handle(coreRequest("/api/rag/jobs/" + JOB, undefined, headers));
  assert.deepEqual((await polled.json()).result.dataset, DATASET);
  const deleted = await handle(coreRequest("/api/rag/datasets/" + DATASET_ID, undefined, headers, "DELETE"));
  assert.deepEqual(await deleted.json(), { deleted: true });
  assert.equal(new Set(calls.map((call) => call.owner)).size, 1);
  assert.deepEqual(calls.map((call) => call.path), ["/datasets", "/datasets/" + DATASET_ID, "/jobs", "/jobs/" + JOB, "/datasets/" + DATASET_ID]);
});

test("Fetch core enforces UTF-8 stream limits even when Content-Length claims less", async () => {
  let requests = 0;
  let cancelled = false;
  const handle = core(async () => { requests++; return Response.json(DATASET_STATUS, { status: 202 }); });
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("가".repeat(3000))); },
    cancel() { cancelled = true; },
  });
  const oversized = new Request("https://site.example/api/rag/jobs", { method: "POST", headers: { "content-type": "application/json", "content-length": "1" }, body, duplex: "half" });
  assert.equal((await handle(oversized)).status, 413);
  assert.equal(cancelled, true);
  const large = { ...SNAPSHOT, data: { ...SNAPSHOT.data, suppliers: [{ name: "가".repeat(4000) }] } };
  assert.equal((await handle(coreRequest("/api/rag/datasets", large, { "x-rag-session": SESSION }))).status, 202);
  const tooLarge = { ...SNAPSHOT, data: { ...SNAPSHOT.data, suppliers: [{ name: "가".repeat(710000) }] } };
  assert.equal((await handle(coreRequest("/api/rag/datasets", tooLarge, { "x-rag-session": SESSION }))).status, 413);
  assert.equal(requests, 1);
});

test("Fetch core bounds upstream response bytes and sanitizes redirect/error headers", async () => {
  const large = core(async () => Response.json({ job_id: JOB, status: "running", hidden: "가".repeat(500) }, { status: 202 }), { maxResponseBytes: 1024 });
  assert.equal((await large(coreRequest("/api/rag/jobs", QUESTION))).status, 502);
  const redirect = core(async () => new Response(TOKEN, { status: 302, headers: { location: "https://private.example/" + TOKEN, "set-cookie": "gateway=" + TOKEN } }));
  const rejected = await redirect(coreRequest("/api/rag/jobs", QUESTION));
  assert.equal(rejected.status, 502);
  assert.equal(rejected.headers.get("location"), null);
  assert.ok(!rejected.headers.get("set-cookie").includes(TOKEN));
  assert.ok(!(await rejected.text()).includes(TOKEN));
  const quota = core(async () => Response.json({ message: TOKEN }, { status: 429, headers: { "retry-after": "999999" } }));
  const limited = await quota(coreRequest("/api/rag/jobs", QUESTION));
  assert.equal(limited.headers.get("retry-after"), "86400");
  assert.ok(!(await limited.text()).includes(TOKEN));
});

test("Fetch core preserves request abort and timeout without leaking runtime exceptions", async () => {
  const handle = core((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error(TOKEN + " private path")), { once: true })), { timeoutMs: 5 });
  const response = await handle(coreRequest("/api/rag/jobs", QUESTION));
  assert.equal(response.status, 504);
  assert.ok(!(await response.text()).includes(TOKEN));
  let requested = false;
  const aborted = new AbortController();
  aborted.abort();
  const noFetch = core(async () => { requested = true; throw new Error(TOKEN); });
  const request = new Request(coreRequest("/api/rag/jobs", QUESTION), { signal: aborted.signal });
  assert.equal((await noFetch(request)).status, 504);
  assert.equal(requested, false);
  assert.throws(() => createRagFetchHandler({}, { cryptoImpl: null }), /Web Crypto/);
});

test("Fetch core error and unexpected-status responses do not wait for stalled stream cancellation", async () => {
  for (const [status, expected] of [[503, 503], [200, 502]]) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(TOKEN)); },
      cancel() { cancelled = true; return new Promise(() => {}); },
    });
    const handle = core(async () => new Response(body, { status }), { timeoutMs: 5 });
    let timer;
    try {
      const response = await Promise.race([
        handle(coreRequest("/api/rag/jobs", QUESTION)),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("stream cancellation blocked the response")), 200); }),
      ]);
      assert.equal(response.status, expected);
      assert.equal(cancelled, true);
      assert.ok(!(await response.text()).includes(TOKEN));
    } finally { clearTimeout(timer); }
  }
});
