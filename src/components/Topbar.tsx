// 상단 바: 브랜드 · 데이터 상태 · AI 연결 상태 · 결제 알림 · 데이터 불러오기/샘플로 되돌리기 · 사용자 메뉴
import { useEffect, useRef, useState } from "react";
import { LuBell, LuBookOpen, LuChevronDown, LuDatabase, LuFileUp, LuLogOut, LuRotateCcw, LuStar, LuTrash2, LuX } from "react-icons/lu";
import { useStore } from "../store/store";
import { useAgent } from "../store/agent";
import { alertCount } from "../lib/payments";
import { BrandBlock } from "./Brand";
import { ConfirmDialog } from "./ConfirmDialog";

function AiStatus() {
  const { state, dispatch } = useStore();
  const { provider, providerChecked } = useAgent();
  const llmOn = state.aiMode === "llm" && !!provider;
  return (
    <div className="ai-status">
      <span className={`dot ${llmOn ? "dot-on" : provider ? "dot-ready" : "dot-off"}`} aria-hidden />
      <span className="ai-status-text" title="LLM(대형 언어 모델)은 질문의 뜻을 해석할 때만 씁니다. 연결되지 않으면 정해진 규칙으로 해석하며, 수치 계산은 어느 쪽이든 데이터로 합니다.">{!providerChecked ? "AI 연결 확인 중" : llmOn ? `LLM 연결됨 · ${provider!.label}` : provider ? "LLM 사용 가능 · 꺼짐" : "LLM 미연결 · 규칙 기반"}</span>
      <div className="mode" role="radiogroup" aria-label="질문 해석 방식">
        <button type="button" role="radio" aria-checked={state.aiMode === "rule"} className={state.aiMode === "rule" ? "is-on" : ""} onClick={() => dispatch({ type: "aiMode", mode: "rule" })} title="정해진 규칙으로 질문을 해석합니다 (항상 사용 가능)">
          규칙 기반
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={state.aiMode === "llm"}
          className={state.aiMode === "llm" ? "is-on" : ""}
          disabled={!provider}
          title={provider ? "질문 해석에 LLM을 사용합니다. 수치 계산은 계속 코드가 합니다." : "LLM이 연결되지 않았습니다. README의 AI API 연결 방법을 참고하세요."}
          onClick={() => dispatch({ type: "aiMode", mode: "llm" })}
        >
          LLM 해석
        </button>
      </div>
    </div>
  );
}

function DataStatus() {
  const { state, derived } = useStore();
  const saved = state.savedAt ? new Date(state.savedAt) : null;
  const hhmm = saved ? `${String(saved.getHours()).padStart(2, "0")}:${String(saved.getMinutes()).padStart(2, "0")}` : "";
  const today = saved ? saved.toDateString() === new Date().toDateString() : false;
  const savedText = saved ? (today ? hhmm : `${saved.getMonth() + 1}/${saved.getDate()} ${hhmm}`) : null;
  const showSaved = !state.meta.isSample;
  return (
    <div className={`data-status ${showSaved ? "has-saved" : ""}`} title={Object.entries(state.meta.sources).map(([k, v]) => `${k}: ${v}`).join("\n")}>
      <LuDatabase aria-hidden />
      <span className={`badge-demo ${state.meta.isSample ? "" : "is-upload"}`} title={state.meta.isSample ? "SAMPLE = 시연용 가상 데이터입니다. 실제 데이터는 ‘데이터 불러오기’로 올립니다." : "업로드한 데이터가 섞여 있습니다. ‘샘플 데이터로 되돌리기’로 되돌릴 수 있습니다."}>{state.meta.isSample ? "SAMPLE" : "업로드 포함"}</span>
      <span className="ds-counts">
        협력사 {derived.supplierViews.length} · 발주 {derived.poViews.length} · 계약 {derived.contractViews.length} · 품목 {derived.itemsByCode.size}
      </span>
      <span className="muted ds-asof">기준일 {state.meta.asOf}</span>
      {showSaved && (
        <span className={`ds-saved ${state.saveError ? "is-bad" : ""}`} title={state.saveError ? "브라우저 저장 공간이 부족하거나 막혀 있어 저장하지 못했습니다. 새로고침하면 업로드 데이터가 사라집니다." : "업로드한 데이터가 이 브라우저에 저장되어 새로고침해도 유지됩니다 (다른 PC·브라우저와는 공유되지 않음)"}>
          {state.saveError ? "브라우저 저장 실패" : savedText ? `이 브라우저에 저장됨 ${savedText}` : "저장 중…"}
        </span>
      )}
    </div>
  );
}

function NotificationBell() {
  const { state, derived, dispatch } = useStore();
  const n = alertCount(derived.payments, state.payChecked);
  const label = n ? `결제 알림 ${n}건 (7일 이내 임박·지급 확인 필요)` : "결제 알림 없음";
  return (
    <button type="button" className={`bell ${n ? "has-alert" : ""}`} onClick={() => dispatch({ type: "goPayments" })} aria-label={`${label} · 대금 결제 일정 보기`} title={`${label} · 누르면 대금 결제 일정으로 이동`}>
      <LuBell aria-hidden />
      {n > 0 && <span className="bell-badge">{n}</span>}
    </button>
  );
}

function UserMenu({ onLogout, onDeleteUpload }: { onLogout: (wipe: boolean) => void; onDeleteUpload: () => void }) {
  const { state, derived, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [wipe, setWipe] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const u = state.user;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const favS = state.favorites.suppliers.map((id) => derived.suppliersById.get(id)).filter(Boolean);
  const favI = state.favorites.items.map((c) => derived.itemsByCode.get(c)).filter(Boolean);

  return (
    <div className="menu-wrap user-menu" ref={ref}>
      <button type="button" className={`user-btn ${open ? "is-on" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" title={`${u.name}${u.dept ? ` · ${u.dept}` : ""}`}>
        <span className="avatar" aria-hidden>
          {u.name.slice(0, 1)}
        </span>
        <span className="user-name">{u.name}</span>
        <LuChevronDown aria-hidden />
      </button>
      {open && (
        <div className="menu menu-right user-pop" role="menu">
          <div className="user-head">
            <span className="avatar avatar-lg" aria-hidden>
              {u.name.slice(0, 1)}
            </span>
            <div>
              <b>{u.name}</b>
              <span className="muted small">{u.dept || "소속 미입력"}</span>
            </div>
          </div>
          <p className="user-note">시연용 간이 로그인 · 대화·분석 이력·관심 목록·업로드 데이터가 이 브라우저에 사용자별로 저장됩니다.</p>
          <div className="fav-section">
            <p className="menu-label">
              <LuStar aria-hidden /> 관심 협력사 ({favS.length})
            </p>
            {favS.length ? (
              favS.map((s) => (
                <span key={s!.supplierId} className="fav-row">
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      dispatch({ type: "subView", tab: "suppliers", view: "list" });
                      dispatch({ type: "selectRow", tab: "suppliers", rowKey: s!.supplierId, supplierId: s!.supplierId });
                      dispatch({ type: "focusData" });
                      setOpen(false);
                    }}
                  >
                    {s!.name}
                  </button>
                  <button type="button" className="icon-btn icon-xs" onClick={() => dispatch({ type: "toggleFav", kind: "suppliers", id: s!.supplierId })} aria-label={`${s!.name} 관심 해제`}>
                    <LuX aria-hidden />
                  </button>
                </span>
              ))
            ) : (
              <span className="muted small">협력사 표의 ☆를 눌러 고정하세요</span>
            )}
            <p className="menu-label">
              <LuStar aria-hidden /> 관심 부품 ({favI.length})
            </p>
            {favI.length ? (
              favI.map((i) => (
                <span key={i!.itemCode} className="fav-row">
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      dispatch({ type: "subView", tab: "inventory", view: "list" });
                      dispatch({ type: "selectRow", tab: "inventory", rowKey: i!.itemCode, itemCode: i!.itemCode });
                      dispatch({ type: "focusData" });
                      setOpen(false);
                    }}
                  >
                    {i!.name}
                  </button>
                  <button type="button" className="icon-btn icon-xs" onClick={() => dispatch({ type: "toggleFav", kind: "items", id: i!.itemCode })} aria-label={`${i!.name} 관심 해제`}>
                    <LuX aria-hidden />
                  </button>
                </span>
              ))
            ) : (
              <span className="muted small">자재-공급관리 표의 ☆를 눌러 고정하세요</span>
            )}
          </div>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              dispatch({ type: "onboarding", open: true });
              setOpen(false);
            }}
          >
            <LuBookOpen aria-hidden /> 사용 안내 다시 보기
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={state.meta.isSample}
            onClick={() => {
              setOpen(false);
              onDeleteUpload();
            }}
            title={state.meta.isSample ? "저장된 업로드 데이터가 없습니다 (지금 SAMPLE 데이터)" : "이 브라우저에 저장된 업로드 데이터를 지우고 샘플 데이터로 되돌립니다"}
          >
            <LuTrash2 aria-hidden /> 저장된 업로드 데이터 삭제
            {state.meta.isSample && <small>없음</small>}
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setConfirm(true);
              setOpen(false);
            }}
          >
            <LuLogOut aria-hidden /> 로그아웃
          </button>
        </div>
      )}
      {confirm && (
        <ConfirmDialog title="로그아웃할까요?" confirmLabel="로그아웃" tone="normal" onCancel={() => setConfirm(false)} onConfirm={() => onLogout(wipe)}>
          <p>다시 같은 이름으로 들어오면 대화·분석 이력·관심 목록이 그대로 남아 있습니다.</p>
          <label className="check-inline wipe-check">
            <input type="checkbox" checked={wipe} onChange={(e) => setWipe(e.target.checked)} id="logout-wipe" />
            <span>이 브라우저에 저장된 내 데이터도 지우기 (공용 PC라면 권장)</span>
          </label>
        </ConfirmDialog>
      )}
    </div>
  );
}

export function Topbar({ onLogout }: { onLogout: (wipe: boolean) => void }) {
  const { state, dispatch } = useStore();
  const [confirmReset, setConfirmReset] = useState(false);
  const datasetFor = state.subView[state.tab] === "list" ? state.tab : state.tab;
  return (
    <header className="topbar">
      <BrandBlock />
      <div className="topbar-right">
        <DataStatus />
        <AiStatus />
        <NotificationBell />
        <div className="topbar-actions">
          <button type="button" className="btn btn-primary" onClick={() => dispatch({ type: "openImport", dataset: datasetFor })} title="CSV·JSON 파일로 데이터 올리기 (형식 검사 후 반영)">
            <LuFileUp aria-hidden /> <span className="hide-md">데이터 </span>불러오기
          </button>
          <button type="button" className="btn btn-quiet sample-reset" onClick={() => setConfirmReset(true)} title="샘플 데이터로 되돌리기 (업로드한 데이터와 이 브라우저의 저장본이 지워집니다)" aria-label="샘플 데이터로 되돌리기">
            <LuRotateCcw aria-hidden />
            <span className="hide-lg">샘플 데이터로 되돌리기</span>
          </button>
        </div>
        <UserMenu onLogout={onLogout} onDeleteUpload={() => setConfirmReset(true)} />
      </div>
      {confirmReset && (
        <ConfirmDialog
          title="샘플 데이터로 되돌릴까요?"
          confirmLabel="샘플로 되돌리기"
          onCancel={() => setConfirmReset(false)}
          onConfirm={() => {
            dispatch({ type: "resetSample" });
            dispatch({ type: "toast", text: "샘플 데이터로 되돌렸습니다. 이 브라우저에 저장된 업로드 데이터도 지웠습니다." });
            setConfirmReset(false);
          }}
        >
          {state.meta.isSample ? (
            <p>지금도 샘플 데이터를 보고 있습니다. 되돌리면 화면의 데이터만 다시 불러옵니다.</p>
          ) : (
            <p>
              업로드한 데이터({(state.meta.uploaded ?? []).length}종)와 이 브라우저에 저장된 업로드 사본이 지워집니다. 대화와 분석 이력은 남지만, 업로드 데이터로 만든 결과에는 ‘다시 분석’ 안내가 뜹니다.
            </p>
          )}
        </ConfirmDialog>
      )}
    </header>
  );
}
