import type { DataMeta, DataSet } from "../data/types";
import { JOB_ID, REVISION, invalid, pause, ragJson, type Fetcher, type RagDataset } from "./rag";

export type WebRagPhase = "idle" | "uploading" | "indexing" | "ready" | "failed";
export interface WebSnapshot { data: DataSet; meta: DataMeta }
interface RegisteredDataset extends RagDataset { clientRevision: string }

/** 로그인한 화면의 메모리에만 둔다. 사용자 이름이나 브라우저 저장값을 인증값으로 쓰지 않는다. */
export function createRagSession(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function observe<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

/** 스냅샷은 질문 직전에 등록한다. 교체/로그아웃 뒤 늦게 생성된 ID도 받아서 정리한다. */
export class WebRagSession {
  private dataset: RegisteredDataset | null = null;
  private pending: { epoch: number; clientRevision: string; promise: Promise<RegisteredDataset> } | null = null;
  private epoch = 0;
  constructor(readonly session: string, private options: { fetcher?: Fetcher; pollIntervalMs?: number; timeoutMs?: number; createTimeoutMs?: number } = {}) {}
  private get fetcher() { return this.options.fetcher ?? fetch; }
  private get headers() { return { "X-Rag-Session": this.session }; }

  private async remove(id: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try { await ragJson(`/api/rag/datasets/${id}`, { method: "DELETE", headers: this.headers, keepalive: true, signal: controller.signal }, this.fetcher); }
    catch { /* 서버의 만료시간도 세션 정리를 보장한다. 화면 종료를 막지 않는다. */ }
    finally { clearTimeout(timer); }
  }

  invalidate(): void {
    this.epoch++;
    const old = this.dataset;
    this.dataset = null;
    this.pending = null;
    if (old) void this.remove(old.id);
  }

  private async register(snapshot: WebSnapshot, epoch: number): Promise<RegisteredDataset> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.createTimeoutMs ?? 30_000);
    try {
      const { meta } = snapshot;
      const body = await ragJson("/api/rag/datasets", {
        method: "POST", headers: { ...this.headers, "content-type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ schema_version: 1, client_revision: meta.dataId,
          meta: { asOf: meta.asOf, isSample: meta.isSample, label: meta.label, sources: meta.sources, uploaded: meta.uploaded ?? [] }, data: snapshot.data }),
      }, this.fetcher);
      if (typeof body.dataset_id !== "string" || !JOB_ID.test(body.dataset_id) || typeof body.revision !== "string" || !REVISION.test(body.revision)) throw invalid();
      const registered = { id: body.dataset_id, revision: body.revision, clientRevision: meta.dataId };
      if (epoch !== this.epoch) {
        void this.remove(registered.id);
        throw new DOMException("웹 데이터가 변경되었습니다.", "AbortError");
      }
      this.dataset = registered;
      if (!["indexing", "ready"].includes(String(body.status)) || !Number.isSafeInteger(body.row_count) || Number(body.row_count) < 0 || !Number.isSafeInteger(body.chunk_count) || Number(body.chunk_count) < 0) {
        this.invalidate();
        throw invalid();
      }
      return registered;
    } finally { clearTimeout(timer); }
  }

  async ensure(snapshot: WebSnapshot, signal: AbortSignal, phase: (value: WebRagPhase) => void): Promise<RagDataset> {
    if (signal.aborted) throw signal.reason;
    if (this.dataset && this.dataset.clientRevision !== snapshot.meta.dataId) this.invalidate();
    if (this.pending && this.pending.clientRevision !== snapshot.meta.dataId) this.invalidate();
    const epoch = this.epoch;
    const controller = new AbortController();
    const aborted = () => {
      controller.abort(signal.reason);
      if (epoch === this.epoch) this.invalidate();
    };
    signal.addEventListener("abort", aborted, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.options.timeoutMs ?? 600_000);
    try {
      let dataset = this.dataset;
      if (!dataset) {
        phase("uploading");
        if (!this.pending) this.pending = { epoch, clientRevision: snapshot.meta.dataId, promise: this.register(snapshot, epoch) };
        const pending = this.pending;
        try { dataset = await observe(pending.promise, controller.signal); }
        finally { if (this.pending === pending) this.pending = null; }
      }
      phase("indexing");
      for (;;) {
        if (epoch !== this.epoch) throw new DOMException("웹 데이터가 변경되었습니다.", "AbortError");
        const body = await ragJson(`/api/rag/datasets/${dataset.id}`, { headers: this.headers, signal: controller.signal }, this.fetcher);
        if (epoch !== this.epoch || controller.signal.aborted) throw new DOMException("웹 데이터가 변경되었습니다.", "AbortError");
        if (body.dataset_id !== dataset.id || body.revision !== dataset.revision) throw invalid();
        if (body.status === "ready") { phase("ready"); return { id: dataset.id, revision: dataset.revision }; }
        if (body.status === "failed") throw new Error("웹 데이터 검색 준비에 실패했습니다. 다음 질문에서 다시 등록해 주세요.");
        if (body.status !== "indexing") throw invalid();
        await pause(this.options.pollIntervalMs ?? 2000, controller.signal);
      }
    } catch (error) {
      if (epoch === this.epoch) this.invalidate();
      if (!signal.aborted) phase("failed");
      if (timedOut) throw new Error("웹 데이터 검색 준비 시간이 초과되었습니다. 다음 질문에서 다시 등록해 주세요.");
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
    }
  }
}
