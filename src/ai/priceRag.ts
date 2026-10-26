import { invalid, JOB_ID, parseAnswer, pause, ragJson, record, RagHttpError, type Fetcher, type RagAnswer } from "./rag";
import { priceContextForRag, type PriceAnalysis } from "../lib/priceComparison";

/** 현재 화면의 가격 조건과 계산값만 전송한다. 기존 구매 DB 식별자로 치환하지 않는다. */
export async function askPriceExplanation(question: string, analysis: PriceAnalysis, options: { signal?: AbortSignal; session: string; fetcher?: Fetcher; pollIntervalMs?: number; timeoutMs?: number }): Promise<RagAnswer> {
  if (!question.trim() || question.length > 1000) throw new Error("질문은 1~1000자로 입력해 주세요.");
  const context = priceContextForRag(analysis);
  const sameContext = (raw: unknown) => record(raw) && raw.analysis_id === context.analysis_id && raw.revision === context.revision;
  const controller = new AbortController();
  const aborted = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) aborted();
  else options.signal?.addEventListener("abort", aborted, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? 660_000);
  const fetcher = options.fetcher ?? fetch;
  const headers = { "X-Rag-Session": options.session };
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    let job = await ragJson("/api/rag/price-explanations", { method: "POST", headers: { ...headers, "content-type": "application/json" }, signal: controller.signal, body: JSON.stringify({ question: question.trim(), model: "qwen3:8b", context }) }, fetcher);
    const id = job.job_id;
    if (typeof id !== "string" || !JOB_ID.test(id)) throw invalid();
    for (;;) {
      if (job.job_id !== id || !sameContext(job.price_context)) throw invalid();
      if (job.status === "succeeded") {
        if (!record(job.result) || !sameContext(job.result.price_context)) throw invalid();
        const answer = parseAnswer(job.result, "qwen3:8b");
        if (answer.sources.some(source => !sameContext(source.source) || source.source.item_code !== context.item.itemCode || !Array.isArray(source.source.record_ids) || !source.source.record_ids.some(id => typeof id === "string" && [...context.supplier_quotes, ...context.external_quotes].some(quote => quote.id === id)))) throw invalid();
        return answer;
      }
      if (job.status === "failed") throw new RagHttpError(typeof job.error_status === "number" ? job.error_status : 502, typeof job.message === "string" ? job.message : "현재 가격 분석의 설명을 생성하지 못했습니다.");
      if (job.status !== "running") throw invalid();
      await pause(options.pollIntervalMs ?? 2000, controller.signal);
      job = await ragJson(`/api/rag/jobs/${id}`, { signal: controller.signal, headers }, fetcher);
    }
  } catch (error) {
    if (timedOut) throw new Error("가격 근거 설명 대기 시간이 초과되었습니다.");
    throw error;
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", aborted); }
}
