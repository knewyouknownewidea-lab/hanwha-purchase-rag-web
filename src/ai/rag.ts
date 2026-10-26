// 구매 DB RAG 전용 클라이언트. 인증 토큰과 게이트웨이 주소는 웹 서버에서만 관리한다.
import type { NegotiationFacts, NegotiationResult } from "../lib/negotiation";
export const RAG_MODELS = ["qwen3:8b", "gemma3:4b", "llama3.1:8b"] as const;
export type RagModel = (typeof RAG_MODELS)[number];
export type ChatMode = "analysis" | "rag" | "web-rag";
export interface RagDataset { id: string; revision: string }
export interface RagConfig { enabled: boolean; models: RagModel[] }
export interface RagSource {
  evidence_id: string;
  chunk_id?: string;
  parent_document_id?: string;
  similarity?: number | null;
  source: { source_refs: string[]; [key: string]: unknown };
}
export interface RagAnswer {
  answer: string;
  status: string;
  model: RagModel;
  modelCalled: boolean;
  sources: RagSource[];
  note?: string;
  dataset?: RagDataset;
  /** 협상 작업(negotiation)일 때만: LangChain 체인이 쓴 보고서·이메일과 서버가 다시 계산한 값 */
  report?: string;
  email?: string;
  facts?: NegotiationResult;
}
export interface RagQuestion {
  question: string;
  model: RagModel;
  top_k?: number;
  order_id?: number;
  supplier_id?: number;
  part_id?: number;
  document_type?: "supplier" | "part" | "supplier_part" | "order" | "complaint";
  dataset?: RagDataset;
  negotiation?: NegotiationFacts;
}
export type Fetcher = typeof fetch;
export const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const invalid = () => new Error("RAG 서버 응답 형식이 올바르지 않습니다. 서버 연결을 확인해 주세요.");
const isModel = (v: unknown): v is RagModel => RAG_MODELS.includes(v as RagModel);
export const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const REVISION = /^[0-9a-f]{64}$/;
export class RagHttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export const sameDataset = (a: unknown, b: RagDataset) => record(a) && a.id === b.id && a.revision === b.revision;

export async function ragJson(url: string, init: RequestInit, fetcher: Fetcher): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetcher(url, { ...init, credentials: "same-origin", headers: { accept: "application/json", ...init.headers } });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new Error("RAG 서버에 연결할 수 없습니다. 네트워크와 서버 실행 상태를 확인해 주세요.");
  }
  let body: unknown;
  try { body = await res.json(); } catch { if (init.signal?.aborted) throw init.signal.reason; throw invalid(); }
  if (!res.ok) {
    const message = record(body) ? typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : null : null;
    throw new RagHttpError(res.status, message || `RAG 요청을 처리하지 못했습니다 (HTTP ${res.status}). 잠시 후 다시 시도해 주세요.`);
  }
  if (!record(body)) throw invalid();
  return body;
}

export async function getRagConfig(signal?: AbortSignal, fetcher: Fetcher = fetch): Promise<RagConfig> {
  const body = await ragJson("/api/rag/status", { signal }, fetcher);
  if (typeof body.enabled !== "boolean" || !Array.isArray(body.models) || !body.models.every(isModel)) throw invalid();
  if (body.enabled && !body.models.length) throw invalid();
  return { enabled: body.enabled, models: [...new Set(body.models)] };
}

const VERDICTS = ["excessive", "within", "insufficient_data"];
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
function parseNegotiation(raw: unknown, model: RagModel): RagAnswer {
  if (!record(raw) || raw.generation_model !== model || typeof raw.model_called !== "boolean" || typeof raw.status !== "string" || !Array.isArray(raw.sources) || raw.sources.length) throw invalid();
  const f = raw.facts;
  if (!record(f) || !num(f.requested_change_pct) || !(num(f.material_change_pct) || f.material_change_pct === null) || !(num(f.gap_pp) || f.gap_pp === null) || !VERDICTS.includes(f.verdict as string)) throw invalid();
  const facts = { requested_change_pct: f.requested_change_pct, material_change_pct: f.material_change_pct, gap_pp: f.gap_pp, verdict: f.verdict } as NegotiationResult;
  const drafted = raw.status === "drafted" || raw.status === "needs_review";
  if (!drafted && !["invalid_generation", "context_limit_exceeded"].includes(raw.status)) throw invalid();
  if (drafted && (typeof raw.report !== "string" || !raw.report.trim() || typeof raw.email !== "string" || !raw.email.trim())) throw invalid();
  const text = typeof raw.answer === "string" && raw.answer.trim() ? raw.answer : raw.message;
  if (typeof text !== "string" || !text.trim()) throw invalid();
  return {
    answer: text, status: raw.status, model, modelCalled: raw.model_called, sources: [], facts,
    ...(drafted ? { report: raw.report as string, email: raw.email as string } : {}),
    ...(typeof raw.note === "string" ? { note: raw.note } : {}),
  };
}

function parseAnswer(raw: unknown, model: RagModel, dataset?: RagDataset): RagAnswer {
  if (!record(raw) || typeof raw.status !== "string" || !Array.isArray(raw.sources) || raw.generation_model !== model || typeof raw.model_called !== "boolean") throw invalid();
  const statuses = ["answered", "clarification_required", "insufficient_evidence", "context_limit_exceeded", "invalid_generation"];
  if (!statuses.includes(raw.status)) throw invalid();
  if (dataset ? !sameDataset(raw.dataset, dataset) : raw.dataset !== undefined) throw invalid();
  const text = typeof raw.answer === "string" && raw.answer.trim() ? raw.answer : raw.message;
  if (typeof text !== "string" || !text.trim() || (raw.status === "answered" && (typeof raw.answer !== "string" || !raw.answer.trim()))) throw invalid();
  const sources: RagSource[] = raw.sources.map((entry: unknown) => {
    if (!record(entry) || typeof entry.evidence_id !== "string" || !/^E[1-9]\d*$/.test(entry.evidence_id) || !record(entry.source) || !Array.isArray(entry.source.source_refs) || !entry.source.source_refs.length || !entry.source.source_refs.every((r: unknown) => typeof r === "string" && r.trim())) throw invalid();
    if (dataset && (entry.source.dataset_id !== dataset.id || entry.source.revision !== dataset.revision)) throw invalid();
    return {
      evidence_id: entry.evidence_id,
      ...(typeof entry.chunk_id === "string" ? { chunk_id: entry.chunk_id } : {}),
      ...(typeof entry.parent_document_id === "string" ? { parent_document_id: entry.parent_document_id } : {}),
      ...(typeof entry.similarity === "number" || entry.similarity === null ? { similarity: entry.similarity } : {}),
      source: { ...entry.source, source_refs: entry.source.source_refs as string[] },
    };
  });
  if (raw.status === "answered") {
    const cited = [...text.matchAll(/\[(E\d+)\]/g)].map((m) => m[1]);
    if (!sources.length || !cited.length || cited.some((id) => !sources.some((s) => s.evidence_id === id))) throw invalid();
  }
  return { answer: text, status: raw.status, model, modelCalled: raw.model_called, sources, ...(dataset ? { dataset } : {}), ...(typeof raw.note === "string" ? { note: raw.note } : {}) };
}

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const done = () => { signal.removeEventListener("abort", aborted); resolve(); };
    const timer = setTimeout(done, ms);
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** 작업은 한 번만 생성한다. 폴링 실패를 새 질문으로 재전송하지 않는다. */
export async function askRag(input: RagQuestion, options: { signal?: AbortSignal; pollIntervalMs?: number; timeoutMs?: number; fetcher?: Fetcher; session?: string } = {}): Promise<RagAnswer> {
  if (!input.question.trim() || input.question.trim().length > 1000) throw new Error("RAG 질문은 1~1000자로 입력해 주세요.");
  if (!isModel(input.model)) throw new Error("사용할 RAG 모델을 선택해 주세요.");
  if (input.dataset && (!JOB_ID.test(input.dataset.id) || !REVISION.test(input.dataset.revision))) throw invalid();
  const controller = new AbortController();
  const externalAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) externalAbort();
  else options.signal?.addEventListener("abort", externalAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? 660_000);
  const fetcher = options.fetcher ?? fetch;
  const headers: Record<string, string> = options.session ? { "X-Rag-Session": options.session } : {};
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    let job = await ragJson("/api/rag/jobs", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ ...input, question: input.question.trim(), top_k: input.top_k ?? 3 }), signal: controller.signal }, fetcher);
    const id = job.job_id;
    if (typeof id !== "string" || !JOB_ID.test(id)) throw invalid();
    for (;;) {
      if (job.job_id !== id) throw invalid();
      if (input.dataset ? !sameDataset(job.dataset, input.dataset) : job.dataset !== undefined) throw invalid();
      if (job.status === "succeeded") return input.negotiation ? parseNegotiation(job.result, input.model) : parseAnswer(job.result, input.model, input.dataset);
      if (job.status === "failed") {
        const message = typeof job.message === "string" && job.message.trim() ? job.message : "RAG 답변 생성에 실패했습니다. 서버 상태를 확인해 주세요.";
        if (typeof job.error_status === "number" && Number.isInteger(job.error_status) && job.error_status >= 400 && job.error_status <= 599) throw new RagHttpError(job.error_status, message);
        throw new Error(message);
      }
      if (job.status !== "running") throw invalid();
      await pause(options.pollIntervalMs ?? 2000, controller.signal);
      job = await ragJson(`/api/rag/jobs/${id}`, { signal: controller.signal, headers }, fetcher);
    }
  } catch (error) {
    if (timedOut) throw new Error("RAG 응답 대기 시간이 초과되었습니다. 서버에서 작업 상태를 확인한 뒤 다시 시도해 주세요.");
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", externalAbort);
  }
}
