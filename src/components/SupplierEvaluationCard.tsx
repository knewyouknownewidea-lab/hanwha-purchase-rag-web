// 데이터 관리 상단: 선택한 협력사의 평가 요약 카드 (다크 테마)
// 평가 근거는 카드 오른쪽 위 '근거' 버튼 → 팝오버로 전체 내용을 보여 준다
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LuCircleAlert, LuCircleCheck, LuCircleDashed, LuFileSearch, LuMessageSquareText, LuX } from "react-icons/lu";
import { useStore } from "../store/store";
import { useAgent } from "../store/agent";
import { EVAL_CONFIG, type SupplierEvaluation } from "../lib/evaluation";
import { fmtNum } from "../lib/format";
import { FavStar } from "./FavStar";

function Donut({ value, grade }: { value: number | null; grade: string | null }) {
  const r = 44;
  const c = 2 * Math.PI * r;
  const p = value === null ? 0 : Math.max(0, Math.min(100, value)) / 100;
  return (
    <svg className="donut" viewBox="0 0 108 108" role="img" aria-label={grade ? `${grade}등급, 종합 ${fmtNum(value)}점` : "평가 불가"}>
      <circle cx="54" cy="54" r={r} className="donut-track" />
      <circle cx="54" cy="54" r={r} className="donut-arc" strokeDasharray={`${c * p} ${c}`} transform="rotate(-90 54 54)" />
      <text x="54" y="52" className="donut-grade" textAnchor="middle">
        {grade ?? "–"}
      </text>
      <text x="54" y="72" className="donut-sub" textAnchor="middle">
        {value === null ? "산정 불가" : `종합 ${fmtNum(value)}점`}
      </text>
    </svg>
  );
}

const STEP_ICON = {
  done: <LuCircleCheck aria-hidden />,
  warn: <LuCircleAlert aria-hidden />,
  todo: <LuCircleDashed aria-hidden />,
};
const STEP_WORD = { done: "완료", warn: "확인 필요", todo: "대기" } as const;

function popoverPos(anchor: HTMLElement) {
  const r = anchor.getBoundingClientRect();
  const width = Math.min(460, window.innerWidth - 24);
  const left = Math.max(12, Math.min(r.right - width, window.innerWidth - width - 12));
  const below = window.innerHeight - r.bottom - 16;
  return { top: r.bottom + 8, left, width, maxH: Math.max(260, below) };
}

/** 평가 근거 팝오버: Esc·바깥 누르기로 닫힘, 열면 안쪽으로 초점, 닫으면 버튼으로 초점 */
function BasisPopover({ anchor, ev, supplierName, onClose }: { anchor: HTMLElement; ev: SupplierEvaluation; supplierName: string; onClose: (restoreFocus: boolean) => void }) {
  const { state } = useStore();
  const { ask } = useAgent();
  const ref = useRef<HTMLDivElement>(null);
  // 처음 그릴 때부터 위치를 계산해 둔다 (숨김 상태로 그리면 초점을 옮길 수 없다)
  const [pos, setPos] = useState(() => popoverPos(anchor));
  const place = useCallback(() => setPos(popoverPos(anchor)), [anchor]);

  useLayoutEffect(() => {
    place();
  }, [place]);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose(true);
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !anchor.contains(t)) onClose(false); // 바깥을 누르면 누른 곳에 초점이 가도록 둔다
    };
    const onScroll = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      place();
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor, onClose, place]);

  const used = ev.criteria.filter((c) => c.score !== null).length;
  return createPortal(
    <div
      ref={ref}
      className="popover basis-pop"
      role="dialog"
      aria-labelledby="basis-pop-title"
      tabIndex={-1}
      id="basis-popover"
      style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxH }}
    >
      <div className="pop-head">
        <div>
          <p className="pop-eyebrow">
            {supplierName} · {state.meta.isSample ? "SAMPLE" : "업로드 데이터"}
          </p>
          <h3 id="basis-pop-title">
            평가 근거 · {ev.grade ?? "–"}등급 {ev.total === null ? "" : `종합 ${fmtNum(ev.total)}점`}
          </h3>
        </div>
        <button type="button" className="icon-btn" onClick={() => onClose(true)} aria-label="평가 근거 닫기" title="닫기 (Esc)">
          <LuX aria-hidden />
        </button>
      </div>
      <div className="pop-body">
        <p className="basis-sum">
          기록된 정량 지표 {used}개로 계산했습니다{ev.missing.length ? ` · 추가 확인이 필요한 항목 ${ev.missing.length}개` : ""}. 최종 등급은 담당자가 검토 후 확정합니다.
        </p>
        <h4>항목별 계산 근거</h4>
        <ul className="basis-list">
          {ev.criteria.map((c) => (
            <li key={c.key}>
              <div className="basis-li-head">
                <b>{c.label}</b>
                <span className="muted">가중치 {c.weight}</span>
                <span className="spacer" />
                <span className={`basis-score ${c.score === null ? "is-missing" : ""}`}>{c.score === null ? "누락" : `${fmtNum(c.score, 0)}점`}</span>
              </div>
              <span className="basis-bar" aria-hidden>
                <span className={`basis-bar-fill ${c.score === null ? "is-missing" : ""}`} style={{ width: `${c.score ?? 0}%` }} />
              </span>
              <p>{c.basis}</p>
              <p className="basis-src">데이터 출처: {c.source}</p>
            </li>
          ))}
        </ul>
        {(ev.missing.length > 0 || ev.notes.length > 0) && (
          <div className="basis-missing">
            <h4>누락·추가 확인 필요</h4>
            <ul>
              {[...ev.missing, ...ev.notes].map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="basis-note">
          {EVAL_CONFIG.name} · 등급 기준 A ≥ 85, B ≥ 75, C ≥ 65. ISO 9001은 외부 공급자 평가를 요구하지만 등급·가중치를 정하지 않으므로 이 점수는 공식 인증 점수가 아닙니다.
        </p>
      </div>
      <div className="pop-foot">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            onClose(false);
            ask(`${supplierName}의 평가 근거를 정리해 줘`);
          }}
          disabled={state.busy}
        >
          <LuMessageSquareText aria-hidden /> 챗봇에서 근거 리포트 만들기
        </button>
      </div>
    </div>,
    document.body,
  );
}

export function SupplierEvaluationCard() {
  const { state, derived, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const sid = state.selection.supplierId;
  const sup = sid ? derived.suppliersById.get(sid) : undefined;
  const ev = sid ? derived.evaluations.get(sid) : undefined;
  const fav = state.favorites.suppliers;
  const favList = derived.supplierViews.filter((s) => fav.includes(s.supplierId));
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) btnRef.current?.focus();
  }, []);

  return (
    <section className="eval-card" aria-labelledby="eval-title">
      <div className="eval-head">
        <div>
          <p className="eval-eyebrow">AI Scoring Agent</p>
          <h2 id="eval-title">AI 에이전트 자동 채점·평가</h2>
          <p className="eval-sub">ISO 9001 관련 품질관리 원칙을 참고한 협력사 평가 항목 및 근거 분석</p>
        </div>
        <div className="eval-head-side">
          <div className="eval-head-tools">
            <span className="eval-tag">{state.meta.isSample ? "SAMPLE" : "업로드 데이터"}</span>
            {sup && ev && (
              <button ref={btnRef} type="button" className={`eval-basis-btn ${open ? "is-on" : ""}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls="basis-popover" aria-haspopup="dialog" title="평가 근거 전체 보기">
                <LuFileSearch aria-hidden /> 근거
              </button>
            )}
          </div>
          {ev && (
            // 처리 단계: 카드 아래 큰 영역 대신 오른쪽 위 구석에 작은 아이콘 줄로 (마우스를 올리면 단계 이름·상태)
            <div className="eval-steps-mini">
            <span className="steps-mini-title" aria-hidden>처리 단계</span>
            <ol className="steps-mini-list" aria-label={`처리 단계: ${ev.steps.map((st) => `${st.label} ${STEP_WORD[st.status]}`).join(", ")}`}>
              {ev.steps.map((st) => (
                <li key={st.label} className={`step-mini step-${st.status}`} title={`${st.label} · ${STEP_WORD[st.status]}${st.detail ? `\n${st.detail}` : ""}`}>
                  {STEP_ICON[st.status]}
                  <span className="step-mini-label">{st.label}</span>
                </li>
              ))}
            </ol>
            </div>
          )}
        </div>
      </div>

      <div className="eval-picker">
        <label htmlFor="eval-supplier">평가 대상</label>
        <select id="eval-supplier" value={sid ?? ""} onChange={(e) => dispatch({ type: "selectSupplier", supplierId: e.target.value })}>
          {favList.length > 0 && (
            <optgroup label="★ 관심 협력사">
              {favList.map((s) => (
                <option key={`f-${s.supplierId}`} value={s.supplierId}>
                  ★ {s.name} ({s.supplierId})
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="전체 협력사">
            {derived.supplierViews
              .filter((s) => !fav.includes(s.supplierId))
              .map((s) => (
                <option key={s.supplierId} value={s.supplierId}>
                  {s.name} ({s.supplierId})
                </option>
              ))}
          </optgroup>
        </select>
        {sup && <FavStar kind="suppliers" id={sup.supplierId} name={sup.name} size="md" />}
      </div>

      {!sup || !ev ? (
        <p className="eval-empty">협력업체 데이터가 없습니다. 상단의 데이터 불러오기로 협력업체 파일을 올려 주세요.</p>
      ) : (
        <>
          <div className="eval-body">
            <Donut value={ev.total} grade={ev.grade} />
            <ul className="eval-bars">
              {ev.criteria.map((c) => (
                <li key={c.key}>
                  <span className="eval-bar-label">{c.label}</span>
                  <span className="eval-bar-track" aria-hidden>
                    <span className={`eval-bar-fill ${c.score === null ? "is-missing" : ""}`} style={{ width: `${c.score ?? 0}%` }} />
                  </span>
                  <span className="eval-bar-val">{c.score === null ? "누락" : fmtNum(c.score, 0)}</span>
                </li>
              ))}
            </ul>
          </div>
          {open && btnRef.current && <BasisPopover anchor={btnRef.current} ev={ev} supplierName={sup.name} onClose={close} />}
        </>
      )}
    </section>
  );
}
