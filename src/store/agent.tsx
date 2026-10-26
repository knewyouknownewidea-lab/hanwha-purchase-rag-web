// 질문 → 답변 → 템플릿 선택 흐름을 화면 어디서든 쓸 수 있게 묶는다
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { answer, type PendingClarify } from "../ai/agent";
import { detectProvider, type LLMProvider } from "../ai/llm";
import { runAnalysis } from "../lib/analysis";
import type { AnalysisResult, TemplateId } from "../lib/analysisTypes";
import { uid, useStore } from "./store";
import { askRag, getRagConfig, RagHttpError, type ChatMode, type RagConfig, type RagModel } from "../ai/rag";
import { createRagSession, WebRagSession, type WebRagPhase } from "../ai/webRag";
import { detectMarketTopic } from "../ai/topic";
import { priceQuestion } from "../ai/priceIntent";
import { buildPriceAnalysis, priceAnalysisResult, type PriceAnalysis } from "../lib/priceComparison";
import { askPriceExplanation } from "../ai/priceRag";
import { getMarketIndicators } from "../ai/marketIndicators";

/** v0.6.0: 챗봇 질문은 구매 DB RAG + qwen3:8b로 고정한다 (선택 UI 없음) */
export const RAG_MODE: ChatMode = "rag";
export const RAG_MODEL: RagModel = "qwen3:8b";

/** 질문으로 바꾼 오른쪽 분석 화면 — 채팅 답변에 '이 결과 다시 보기'·안내로 연결한다 */
interface PanelInfo { resultId?: string; shownAs?: TemplateId; followup?: boolean; note: string; priceAnalysis?: PriceAnalysis }
interface ActiveRequest { controller: AbortController; mode: ChatMode; revision: string; version: number; priceRevision?: string; priceItemCode?: string }

interface AgentApi {
  ask: (question: string, opts?: { answeringId?: string; mode?: ChatMode }) => Promise<void>;
  /** 질문에서 찾은 대상으로 오른쪽 분석 결과창만 바꾼다 (웹 화면 데이터 기준) */
  explore: (question: string, pending?: PendingClarify | null) => Promise<PanelInfo>;
  choose: (resultId: string, template: TemplateId) => void;
  rerun: (result: AnalysisResult) => void;
  provider: LLMProvider | null;
  providerChecked: boolean;
  chatMode: ChatMode;
  ragReady: boolean;
  ragConfig: RagConfig | null;
  ragChecking: boolean;
  ragConfigError: string | null;
  refreshRagConfig: () => void;
  webRagPhase: WebRagPhase;
}

const Ctx = createContext<AgentApi | null>(null);

export const isNarrow = () => typeof window !== "undefined" && window.matchMedia("(max-width: 1180px)").matches;

export function AgentProvider({ children }: { children: ReactNode }) {
  const store = useStore();
  const ref = useRef(store);
  ref.current = store;
  const [provider, setProvider] = useState<LLMProvider | null>(null);
  const [checked, setChecked] = useState(false);
  const [chatMode, setChatMode] = useState<ChatMode>(RAG_MODE);
  const [ragConfig, setRagConfig] = useState<RagConfig | null>(null);
  const [ragChecking, setRagChecking] = useState(false);
  const [ragConfigError, setRagConfigError] = useState<string | null>(null);
  const [webRagPhase, setWebRagPhase] = useState<WebRagPhase>("idle");
  const [webSession] = useState(() => new WebRagSession(createRagSession()));
  const alive = useRef(true);
  const activeRequest = useRef<ActiveRequest | null>(null);
  const configRequest = useRef<AbortController | null>(null);
  const lastRevision = useRef(store.state.meta.dataId);
  const lastVersion = useRef(store.state.meta.version);
  const hasPriceAnalysis = Object.values(store.state.results).some(result => !!result.priceAnalysis);

  useEffect(() => {
    const s = store.state;
    if (!hasPriceAnalysis) return;
    const controller = new AbortController();
    getMarketIndicators(controller.signal).then(indicators => {
      if (!controller.signal.aborted && alive.current && ref.current.state.meta.dataId === s.meta.dataId) ref.current.dispatch({ type: "priceIndicators", indicators });
    });
    return () => controller.abort();
  }, [hasPriceAnalysis, store.state.meta.dataId]);

  useEffect(() => {
    const request = activeRequest.current;
    if (!request?.priceRevision) return;
    const s = store.state;
    if (request.priceRevision === s.priceInputs.revision && request.revision === s.meta.dataId && (!s.selection.itemCode || s.selection.itemCode === request.priceItemCode)) return;
    activeRequest.current = null;
    request.controller.abort();
    store.dispatch({ type: "busy", busy: false });
    store.dispatch({ type: "toast", text: "가격 비교 조건이 변경되어 이전 설명 요청을 중단했습니다. 현재 표를 기준으로 다시 질문해 주세요.", tone: "warn" });
  }, [store.state.priceInputs.revision, store.state.meta.dataId, store.state.selection.itemCode]);

  const refreshRagConfig = useCallback(() => {
    configRequest.current?.abort();
    if (window.location.protocol === "file:") {
      setRagConfigError("구매 DB RAG는 웹 서버를 통해 열어야 사용할 수 있습니다.");
      return;
    }
    const controller = new AbortController();
    configRequest.current = controller;
    setRagChecking(true);
    setRagConfigError(null);
    const timer = setTimeout(() => controller.abort(), 8000);
    getRagConfig(controller.signal).then((config) => {
      if (!alive.current || configRequest.current !== controller) return;
      setRagConfig(config);
    }).catch(() => {
      if (!alive.current || configRequest.current !== controller) return;
      setRagConfig(null);
      setRagConfigError("RAG 연결 설정을 확인하지 못했습니다. 웹 서버 상태를 확인해 주세요.");
    }).finally(() => {
      clearTimeout(timer);
      if (alive.current && configRequest.current === controller) setRagChecking(false);
    });
  }, []);

  useEffect(() => {
    alive.current = true;
    refreshRagConfig();
    return () => {
      alive.current = false;
      configRequest.current?.abort();
      activeRequest.current?.controller.abort();
      activeRequest.current = null;
      webSession.invalidate();
    };
  }, [refreshRagConfig, webSession]);

  useEffect(() => {
    const stop = () => {
      const request = activeRequest.current;
      activeRequest.current = null;
      request?.controller.abort();
      webSession.invalidate();
      if (alive.current) {
        setWebRagPhase("idle");
        if (request) ref.current.dispatch({ type: "busy", busy: false });
      }
    };
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      // BFCache 복원은 Provider를 다시 만들지 않는다. 폐기한 스냅샷은 다음 질문에서 새로 등록한다.
      stop();
      refreshRagConfig();
    };
    window.addEventListener("pagehide", stop);
    window.addEventListener("pageshow", restore);
    return () => {
      window.removeEventListener("pagehide", stop);
      window.removeEventListener("pageshow", restore);
    };
  }, [refreshRagConfig, webSession]);

  useEffect(() => {
    if (lastRevision.current === store.state.meta.dataId && lastVersion.current === store.state.meta.version) return;
    lastRevision.current = store.state.meta.dataId;
    lastVersion.current = store.state.meta.version;
    webSession.invalidate();
    setWebRagPhase("idle");
    const request = activeRequest.current;
    if (request?.mode === "web-rag") {
      activeRequest.current = null;
      request.controller.abort();
      store.dispatch({ type: "busy", busy: false });
      store.dispatch({ type: "toast", text: "웹 데이터가 변경되어 이전 RAG 요청을 중단했습니다. 현재 데이터로 다시 질문해 주세요.", tone: "warn" });
    }
  }, [store.state.meta.dataId, store.state.meta.version, store.dispatch, webSession]);

  useEffect(() => {
    let alive = true;
    detectProvider().then((p) => {
      if (!alive) return;
      setProvider(p);
      setChecked(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const ragReady = !!ragConfig?.enabled && ragConfig.models.includes(RAG_MODEL) && !ragChecking;

  const explore = useCallback(async (question: string, pending?: PendingClarify | null): Promise<PanelInfo> => {
    const { state, dispatch, derived } = ref.current;
    const q = question.trim();
    const activePrice = !state.topic && state.view.resultId ? state.results[state.view.resultId]?.priceAnalysis : undefined;
    const selection = pending ? null : priceQuestion(q, state.data, state.selection, activePrice?.dataId === state.meta.dataId ? activePrice : undefined);
    if (selection) {
      if (!selection.itemCode) {
        dispatch({ type: "topic", topic: { kind: "unclear", question: q, message: selection.reason ?? "가격 비교 품목을 선택해 주세요.", options: state.data.items.map(item => ({ label: `${item.name} (${item.itemCode})`, ask: `${item.name} 업체별 단가를 시장 참고가격과 비교해줘` })) } });
        if (isNarrow()) dispatch({ type: "panel", panel: "C" });
        return { note: "오른쪽 분석 결과창: 가격 비교 품목 선택 필요" };
      }
      const context = buildPriceAnalysis(state.data, state.meta, state.priceInputs, { itemCode: selection.itemCode, supplierIds: selection.supplierIds });
      const result = priceAnalysisResult(context, derived, q);
      const shownAs: TemplateId = /보고서/.test(q) ? "report" : /그래프|시각화/.test(q) ? "chart" : activePrice && state.view.template ? state.view.template : "table";
      dispatch({ type: "addResult", result });
      dispatch({ type: "pending", pending: null });
      dispatch({ type: "show", resultId: result.id, template: shownAs });
      if (isNarrow()) dispatch({ type: "panel", panel: "C" });
      return { resultId: result.id, shownAs, followup: !!activePrice, priceAnalysis: context, note: "화면·채팅·보고서는 동일한 외부 견적 중앙값과 비교 조건을 사용합니다." };
    }
    const topic = pending ? null : detectMarketTopic(q, state.data, state.meta.asOf);
    let info: PanelInfo;
    if (topic) {
      dispatch({ type: "topic", topic });
      info = { note: topic.kind === "material" ? `오른쪽 분석 결과창: ${topic.material} 시세 추이 (웹 화면 데이터)` : topic.kind === "wage" ? `오른쪽 분석 결과창: ${topic.path.at(-1)} 임금 추이 (웹 화면 데이터)` : "오른쪽 분석 결과창: 추가 선택 필요" };
    } else {
      // 시세·임금이 아니면 기존 웹 데이터 분석 규칙으로 대상을 찾는다. 질문에 적은 대상만 쓰도록 왼쪽 행 선택은 넘기지 않는다.
      const reply = await answer(q, { data: state.data, derived, meta: state.meta, selection: {}, lastResult: state.lastResultId ? state.results[state.lastResultId] : null, pending: pending ?? null }, null);
      if (reply.type === "analysis") {
        const r = reply.result;
        const cur = ref.current.state.view.template;
        const shownAs = reply.followup && cur && r.templates.includes(cur) ? cur : r.recommended;
        dispatch({ type: "addResult", result: r });
        dispatch({ type: "show", resultId: r.id, template: shownAs });
        info = { resultId: r.id, shownAs, followup: reply.followup, note: "오른쪽 분석 결과: 웹 화면 데이터로 계산" };
      } else {
        dispatch({
          type: "topic",
          topic: { kind: "unclear", question: q, message: reply.text.join(" "), options: reply.type === "clarify" ? reply.options.map((o) => ({ label: o.label })) : [], pending: reply.type === "clarify" ? reply.pending : undefined },
        });
        info = { note: reply.type === "clarify" ? "오른쪽 분석 결과창: 추가 선택 필요" : "오른쪽 분석 결과창: 표시할 분석 없음" };
      }
    }
    if (isNarrow()) dispatch({ type: "panel", panel: "C" });
    return info;
  }, []);

  const ask = useCallback(
    async (question: string, opts?: { answeringId?: string; mode?: ChatMode }) => {
      const { state, dispatch, derived } = ref.current;
      const q = question.trim();
      // 기존 평가 카드·선택 정보의 분석 버튼은 계속 웹 데이터 분석을 사용한다.
      const mode = opts?.mode ?? "analysis";
      if (!q || state.busy || activeRequest.current) return;
      if (mode === "web-rag" && !ragConfig?.enabled) {
        dispatch({ type: "toast", text: "RAG 서버 연결 설정을 확인해 주세요.", tone: "warn" });
        return;
      }
      const request: ActiveRequest = { controller: new AbortController(), mode, revision: state.meta.dataId, version: state.meta.version };
      activeRequest.current = request;
      const current = () => alive.current && activeRequest.current === request && !request.controller.signal.aborted && (mode !== "web-rag" || (ref.current.state.meta.dataId === request.revision && ref.current.state.meta.version === request.version)) && (!request.priceRevision || (ref.current.state.meta.dataId === request.revision && ref.current.state.priceInputs.revision === request.priceRevision));
      setChatMode(mode);
      if (opts?.answeringId) dispatch({ type: "patchMessage", id: opts.answeringId, patch: { answered: q } });
      dispatch({ type: "addMessage", message: { id: uid(), role: "user", text: q, at: new Date().toISOString(), mode } });
      dispatch({ type: "busy", busy: true, progress: 0 });
      try {
        // 질문 → 오른쪽 분석 화면을 먼저 바꾸고(웹 화면 데이터), 그다음 구매 DB RAG 답변을 기다린다
        const panel = mode === "rag"
          ? await explore(q).catch((): PanelInfo => {
              dispatch({ type: "topic", topic: { kind: "unclear", question: q, message: "질문에서 분석 대상을 찾지 못했습니다.", options: [] } });
              return { note: "오른쪽 분석 결과창: 추가 선택 필요" };
            })
          : null;
        const panelLink = panel?.resultId ? { resultId: panel.resultId, shownAs: panel.shownAs, followup: panel.followup } : {};
        if (panel?.priceAnalysis) {
          const context = panel.priceAnalysis;
          request.priceRevision = ref.current.state.priceInputs.revision;
          request.priceItemCode = context.item.itemCode;
          if (!ragReady) {
            dispatch({ type: "addMessage", message: { id: uid(), role: "assistant", at: new Date().toISOString(), engine: "system", ...panelLink, priceRevision: request.priceRevision, priceDataId: request.revision, text: ["현재 화면의 가격·차액·차이율은 코드로 계산했습니다. RAG 서버에 연결되지 않아 문서 검색과 LLM 설명을 수행하지 못했습니다. 오른쪽의 비교 조건과 계산 결과를 확인해 주세요."], engineNote: panel.note } });
            return;
          }
          const reply = await askPriceExplanation(q, context, { signal: request.controller.signal, session: webSession.session });
          if (!current()) return;
          dispatch({ type: "addMessage", message: { id: uid(), role: "assistant", at: new Date().toISOString(), engine: "rag", ...panelLink, priceRevision: request.priceRevision, priceDataId: request.revision, text: [reply.answer], ragSources: reply.sources, ragModel: reply.model, ragStatus: reply.status, engineNote: [panel.note, reply.note, "단가·중앙값·차액·차이율은 코드 계산값이며 평가점수로 가격을 보정하지 않았습니다."].filter(Boolean).join(" · ") } });
          return;
        }
        if (mode === "rag" && !ragReady) {
          // RAG를 쓸 수 없어도 답변을 지어내지 않고, 오른쪽 분석 화면만 보여 준다 (RAG 연결 없는 공개 페이지 포함)
          dispatch({ type: "addMessage", message: {
            id: uid(), role: "assistant", at: new Date().toISOString(), engine: "system", ...panelLink,
            text: [`RAG 서버에 연결되지 않아 구매 DB 답변을 만들지 않았습니다 (${ragChecking ? "연결 확인 중" : !ragConfig?.enabled ? "연결 설정 필요" : `${RAG_MODEL} 사용 불가`}). 오른쪽 분석 결과창은 웹 화면 데이터로 표시합니다.`],
            engineNote: panel?.note,
          } });
          return;
        }
        if (mode !== "analysis") {
          const dataset = mode === "web-rag"
            ? await webSession.ensure({ data: state.data, meta: state.meta }, request.controller.signal, (phase) => { if (current()) setWebRagPhase(phase); })
            : undefined;
          if (!current()) return;
          // 웹 화면의 SUP-/ITM-/PO- 샘플 ID와 선택 문맥은 별도 구매 DB에 전달하지 않는다.
          const reply = await askRag({ question: q, model: RAG_MODEL, ...(dataset ? { dataset } : {}) }, { signal: request.controller.signal, session: webSession.session });
          if (!current()) return;
          dispatch({ type: "addMessage", message: {
            id: uid(), role: "assistant", at: new Date().toISOString(), engine: mode, text: [reply.answer], ...panelLink,
            ragSources: reply.sources, ragModel: reply.model, ragStatus: reply.status,
            ...(dataset ? { ragDataset: dataset, ragClientRevision: request.revision } : {}),
            engineNote: [mode === "web-rag" ? `웹 데이터 기준 · ${state.meta.label} · 최종 판단은 담당자` : "구매 DB 기준 · 최종 판단은 담당자", reply.note, panel?.note].filter(Boolean).join(" · "),
          } });
          if (!ref.current.state.chatOpen) dispatch({ type: "chat", open: true });
          return;
        }
        const reply = await answer(
          q,
          {
            data: state.data,
            derived,
            meta: state.meta,
            selection: state.selection,
            lastResult: state.lastResultId ? state.results[state.lastResultId] : null,
            pending: state.pending,
          },
          state.aiMode === "llm" ? provider : null,
          (i) => { if (current()) dispatch({ type: "busy", busy: true, progress: i }); },
        );
        if (!current()) return;
        const base = { id: uid(), role: "assistant" as const, at: new Date().toISOString(), engine: reply.engine, engineNote: reply.engineNote, text: reply.text };
        if (reply.type === "analysis") {
          // b 방식: 분석이 끝나면 바로 결과창에 그린다. 후속 질문이면 보던 형식을 유지한다.
          const r = reply.result;
          const current = ref.current.state.view.template;
          const shownAs = reply.followup && current && r.templates.includes(current) ? current : r.recommended;
          dispatch({ type: "addResult", result: r });
          dispatch({ type: "pending", pending: null });
          dispatch({ type: "show", resultId: r.id, template: shownAs });
          dispatch({ type: "addMessage", message: { ...base, resultId: r.id, followup: reply.followup, shownAs } });
          if (isNarrow()) dispatch({ type: "panel", panel: "C" });
        } else if (reply.type === "clarify") {
          dispatch({ type: "pending", pending: reply.pending });
          dispatch({ type: "addMessage", message: { ...base, options: reply.options, need: reply.pending.need, answered: null } });
          if (!ref.current.state.chatOpen) dispatch({ type: "chat", open: true });
        } else {
          dispatch({ type: "addMessage", message: { ...base, suggestions: reply.suggestions } });
          if (!ref.current.state.chatOpen) dispatch({ type: "chat", open: true });
        }
      } catch (e) {
        if (!current()) return;
        const expired = mode === "web-rag" && e instanceof RagHttpError && (e.status === 404 || e.status === 409);
        if (expired) { webSession.invalidate(); setWebRagPhase("idle"); }
        dispatch({
          type: "addMessage",
          message: { id: uid(), role: "assistant", at: new Date().toISOString(), engine: mode !== "analysis" ? mode : "system", text: [expired ? "웹 데이터 검색 세션이 만료되었거나 변경되었습니다. 다시 질문하면 현재 데이터를 새로 등록합니다." : mode !== "analysis" ? `RAG 요청을 완료하지 못했습니다: ${(e as Error).message}` : `분석 중 오류가 났습니다: ${(e as Error).message}. 데이터 형식을 확인한 뒤 다시 질문해 주세요.`] },
        });
      } finally {
        if (activeRequest.current === request) {
          activeRequest.current = null;
          if (alive.current) dispatch({ type: "busy", busy: false });
        }
      }
    },
    [provider, ragConfig, ragReady, ragChecking, webSession, explore],
  );

  const choose = useCallback((resultId: string, template: TemplateId) => {
    const { dispatch } = ref.current;
    dispatch({ type: "show", resultId, template });
    if (isNarrow()) dispatch({ type: "panel", panel: "C" });
  }, []);

  const rerun = useCallback((result: AnalysisResult) => {
    const { state, dispatch, derived } = ref.current;
    try {
      const next = result.priceAnalysis
        ? priceAnalysisResult(buildPriceAnalysis(state.data, state.meta, state.priceInputs, { itemCode: result.priceAnalysis.item.itemCode, supplierIds: result.priceAnalysis.supplierIds }), derived, result.question)
        : runAnalysis(result.params, state.data, derived, state.meta, result.question);
      dispatch({ type: "addResult", result: next, asLast: state.lastResultId === result.id });
      dispatch({ type: "show", resultId: next.id, template: state.view.template ?? next.recommended });
      dispatch({ type: "toast", text: next.empty ? `다시 분석했지만 결과가 없습니다: ${next.empty}` : "현재 데이터로 다시 분석했습니다", tone: next.empty ? "warn" : "ok" });
    } catch (e) {
      dispatch({ type: "toast", text: `다시 분석하지 못했습니다: ${(e as Error).message}`, tone: "warn" });
    }
  }, []);

  const value = useMemo(() => ({ ask, explore, choose, rerun, provider, providerChecked: checked, chatMode, ragReady, ragConfig, ragChecking, ragConfigError, refreshRagConfig, webRagPhase }), [ask, explore, choose, rerun, provider, checked, chatMode, ragReady, ragConfig, ragChecking, ragConfigError, refreshRagConfig, webRagPhase]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAgent(): AgentApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("AgentProvider가 없습니다");
  return v;
}
