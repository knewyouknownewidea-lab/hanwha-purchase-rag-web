// 단가 인상 협상 화면: 견적서 입력(또는 계약 데이터) → 코드가 계산한 대조표·판정 → LangChain 체인이 쓴 협상 논리 보고서·공문 이메일 초안
import { useMemo, useState } from "react";
import { LuCopy, LuFileText, LuMail, LuTriangleAlert } from "react-icons/lu";
import { useStore } from "../store/store";
import { RAG_MODE, RAG_MODEL, useAgent } from "../store/agent";
import type { Topic } from "../ai/topic";
import { analyze, buildFacts, DEFAULT_THRESHOLD_PP, VERDICT_LABEL, type NegotiationFacts } from "../lib/negotiation";
import { fmtSignedPct } from "../lib/format";
import { priceText } from "./ContractPrices";

type NegotiationTopic = Extract<Topic, { kind: "negotiation" }>;
const n = (v: string) => (v.trim() === "" ? null : Number(v.replace(/,/g, "")));
const sameFacts = (a?: NegotiationFacts, b?: NegotiationFacts | null) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

export function NegotiationPanel({ topic }: { topic: NegotiationTopic }) {
  const { state, derived, dispatch } = useStore();
  const { ask, ragReady } = useAgent();
  const contract = derived.contractViews.find((c) => c.supplierId === topic.supplierId && c.itemCode === topic.itemCode);
  const [source, setSource] = useState<"contract" | "quote">(topic.quotePct != null ? "quote" : "contract");
  const [prev, setPrev] = useState(contract ? String(contract.unitPrice) : "");
  const [requested, setRequested] = useState(contract && topic.quotePct != null ? String(Math.round(contract.unitPrice * (1 + topic.quotePct / 100))) : "");
  const [threshold, setThreshold] = useState(String(DEFAULT_THRESHOLD_PP));
  const th = n(threshold);
  const facts = useMemo(
    () => (th === null || !Number.isFinite(th) || th < 0 || th > 50 ? null
      : buildFacts(state.data, derived, state.meta.isSample, topic.supplierId, topic.itemCode, source === "quote" ? { prevPrice: n(prev), requestedPrice: n(requested) } : {}, th)),
    [state.data, derived, state.meta.isSample, topic.supplierId, topic.itemCode, source, prev, requested, th],
  );
  const local = facts ? analyze(facts) : null;
  const draft = topic.draft;
  // 서버가 다시 계산한 값이 있으면 그 값을 보인다(보고서 문장과 같은 숫자)
  const shown = draft?.result && sameFacts(draft.facts, facts) ? draft.result : local;
  const stale = draft?.state === "done" && !sameFacts(draft.facts, facts);
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      dispatch({ type: "toast", text: `${what}를 복사했습니다` });
    } catch {
      dispatch({ type: "toast", text: "이 화면에서는 복사할 수 없습니다. 글을 직접 선택해 복사해 주세요.", tone: "warn" });
    }
  };
  const write = () => facts && ask(`${facts.supplier} ${facts.item} ${facts.source === "quote" ? "견적서" : "계약 단가"} 기준 협상 보고서 작성`, { mode: RAG_MODE, negotiation: facts });

  return (
    <div className="nego" data-verdict={shown?.verdict ?? "none"}>
      <div className="nego-head">
        <h3>
          {derived.suppliersById.get(topic.supplierId)?.name} · {derived.itemsByCode.get(topic.itemCode)?.name} 단가 인상 협상
        </h3>
        <span className="sv-badge">{state.meta.isSample ? "SAMPLE · 실제 자료 아님" : state.meta.label}</span>
      </div>

      <fieldset className="nego-form">
        <legend>공급사 요구 단가</legend>
        <div className="seg-ctl" role="radiogroup" aria-label="요구 단가 출처">
          <button type="button" role="radio" aria-checked={source === "contract"} className={source === "contract" ? "is-on" : ""} onClick={() => setSource("contract")}>
            계약 데이터 (직전 → 최근 단가)
          </button>
          <button type="button" role="radio" aria-checked={source === "quote"} className={source === "quote" ? "is-on" : ""} onClick={() => setSource("quote")}>
            견적서 입력
          </button>
        </div>
        {source === "quote" ? (
          <div className="nego-inputs">
            <label>
              기존 단가 ({contract?.currency ?? "KRW"})
              <input id="nego-prev" inputMode="decimal" value={prev} onChange={(e) => setPrev(e.target.value)} />
            </label>
            <label>
              견적서 요구 단가 ({contract?.currency ?? "KRW"})
              <input id="nego-req" inputMode="decimal" value={requested} onChange={(e) => setRequested(e.target.value)} placeholder="예: 1400000" />
            </label>
          </div>
        ) : (
          <p className="nego-hint">{contract ? `계약 ${contract.contractId}: ${contract.prevUnitPrice != null ? priceText({ unitPrice: contract.prevUnitPrice, currency: contract.currency }, derived.itemsByCode.get(contract.itemCode)?.unit) : "직전 단가 없음"} → ${priceText(contract, derived.itemsByCode.get(contract.itemCode)?.unit)}` : "계약 단가 데이터가 없습니다. 견적서 값을 입력해 주세요."}</p>
        )}
        <label className="nego-th">
          과도 판정 기준 (요구 인상률 − 소재 평균 인상률, %p · 예시 기준)
          <input id="nego-th" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        </label>
      </fieldset>

      {!facts || !shown ? (
        <p className="topic-unclear" data-unclear>
          <LuTriangleAlert aria-hidden /> 기존 단가·요구 단가·판정 기준을 확인해 주세요. 값이 없거나 0 이하이면 계산하지 않습니다.
        </p>
      ) : (
        <>
          <table className="data-table nego-table" aria-label="원자재 인상률과 요구 인상률 대조">
            <tbody>
              <tr><th scope="row">요구 인상률 ({facts.source === "quote" ? "견적서" : "계약 단가"})</th><td className="num" data-k="requested">{fmtSignedPct(shown.requested_change_pct)}</td><td>{priceText({ unitPrice: facts.prev_price, currency: facts.currency }, facts.unit)} → {priceText({ unitPrice: facts.requested_price, currency: facts.currency }, facts.unit)}</td></tr>
              {facts.materials.map((m) => (
                <tr key={m.name}><th scope="row">소재 · {m.name}</th><td className="num">{m.change_pct === null ? "자료 없음" : fmtSignedPct(m.change_pct)}</td><td>국내 시세 전년 같은 달 대비</td></tr>
              ))}
              <tr><th scope="row">주요 소재 평균 인상률</th><td className="num" data-k="material">{shown.material_change_pct === null ? "자료 없음" : fmtSignedPct(shown.material_change_pct)}</td><td>단순 평균 · {facts.period}</td></tr>
              <tr><th scope="row">차이</th><td className="num" data-k="gap">{shown.gap_pp === null ? "계산 불가" : `${shown.gap_pp > 0 ? "+" : ""}${shown.gap_pp}%p`}</td><td>기준 {facts.threshold_pp}%p 초과 시 과도 가능성</td></tr>
            </tbody>
          </table>
          <p className={`nego-verdict is-${shown.verdict}`} role="status" data-k="verdict">
            판정: <b>{VERDICT_LABEL[shown.verdict]}</b> — 원자재가 단가에서 차지하는 비중 자료는 없어 비중을 반영하지 않았습니다. 최종 판단은 담당자가 합니다.
          </p>
          <div className="nego-actions">
            <button type="button" className="btn btn-primary" id="nego-write" onClick={write} disabled={state.busy || !ragReady}>
              <LuFileText aria-hidden /> 이 조건으로 보고서·이메일 작성
            </button>
            <span className="muted small">{ragReady ? `LangChain 체인 · ${RAG_MODEL} · 1~2분 걸립니다` : "RAG 서버에 연결되지 않아 문장 작성은 할 수 없습니다. 위 계산 결과는 그대로 쓸 수 있습니다."}</span>
          </div>
        </>
      )}

      {draft && (
        <section className="nego-draft" aria-label="협상 논리 보고서와 공문 이메일 초안" data-state={draft.state} data-status={draft.status ?? ""}>
          {draft.state === "drafting" ? (
            <p role="status">보고서·이메일 초안 작성 중 ({RAG_MODEL})…</p>
          ) : draft.state === "failed" ? (
            <p className="note-warn">작성하지 못했습니다: {draft.message}</p>
          ) : !draft.report || !draft.email ? (
            <p className="note-warn">{draft.message}</p>
          ) : (
            <>
              {stale && <p className="note-warn">입력이 바뀌었습니다. 아래 초안은 이전 조건 기준입니다. 다시 작성해 주세요.</p>}
              {draft.note && <p className={draft.status === "needs_review" ? "note-warn" : "muted small"} data-k="note">{draft.note}</p>}
              <div className="nego-doc">
                <div className="nego-doc-head">
                  <h4><LuFileText aria-hidden /> 협상 논리 보고서 <small>구매팀 내부용</small></h4>
                  <button type="button" className="btn btn-quiet btn-small" onClick={() => copy(draft.report!, "보고서")}><LuCopy aria-hidden /> 복사</button>
                </div>
                <pre className="nego-text" data-k="report">{draft.report}</pre>
              </div>
              <div className="nego-doc">
                <div className="nego-doc-head">
                  <h4><LuMail aria-hidden /> 공문 이메일 초안 <small>공급사 담당자에게 · 보내기 전 검토</small></h4>
                  <button type="button" className="btn btn-quiet btn-small" onClick={() => copy(draft.email!, "이메일 초안")}><LuCopy aria-hidden /> 복사</button>
                </div>
                <pre className="nego-text" data-k="email">{draft.email}</pre>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
