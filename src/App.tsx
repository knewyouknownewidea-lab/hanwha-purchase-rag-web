// MainDashboard: 간이 로그인 → 상단 바 + 데이터 관리(왼쪽) · 분석 결과(오른쪽) 2분할 + 떠 있는 AI 챗봇
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { LuDatabase, LuPanelRight } from "react-icons/lu";
import { StoreProvider, useStore, type Panel } from "./store/store";
import { AgentProvider } from "./store/agent";
import { SupplierEvaluationCard } from "./components/SupplierEvaluationCard";
import { DataManagementTabs } from "./components/DataManagementTabs";
import { ChatWidget } from "./components/ChatWidget";
import { readStore, writeStore } from "./platform/storage";
import { currentUser, logout, type User } from "./platform/users";
import { ResultPanel } from "./components/ResultPanel";
import { ImportDialog } from "./components/ImportDialog";
import { Topbar } from "./components/Topbar";
import { Onboarding } from "./components/Onboarding";
import { LoginScreen } from "./components/LoginScreen";
import { BRAND } from "./brand";

const PANEL_TABS: { id: Panel; label: string; icon: ReactNode }[] = [
  { id: "A", label: "데이터 관리", icon: <LuDatabase aria-hidden /> },
  { id: "C", label: "분석 결과", icon: <LuPanelRight aria-hidden /> },
];

function Toast() {
  const { state, dispatch } = useStore();
  useEffect(() => {
    if (!state.toast) return;
    const t = setTimeout(() => dispatch({ type: "clearToast" }), 3600);
    return () => clearTimeout(t);
  }, [state.toast, dispatch]);
  if (!state.toast) return null;
  return (
    <div className={`toast toast-${state.toast.tone}`} role="status" key={state.toast.id}>
      {state.toast.text}
    </div>
  );
}

const SPLIT_KEY = "split.v1";
const SPLIT_DEFAULT = 45;
const SPLIT_MIN = 30;
const SPLIT_MAX = 70;

/** 데이터 관리(왼쪽) : 분석 결과(오른쪽) = 45 : 55, 가운데 경계선을 끌거나 화살표 키로 조절 */
function useSplit() {
  const [left, setLeft] = useState<number>(() => {
    const v = readStore<number>(SPLIT_KEY);
    return typeof v === "number" && v >= SPLIT_MIN && v <= SPLIT_MAX ? v : SPLIT_DEFAULT;
  });
  const set = (v: number) => {
    const c = Math.round(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v)) * 10) / 10;
    setLeft(c);
    writeStore(SPLIT_KEY, c);
  };
  return [left, set] as const;
}

function Workspace() {
  const { state, dispatch } = useStore();
  const hasResult = !!state.view.resultId;
  const [left, setLeft] = useSplit();
  const mainRef = useRef<HTMLElement>(null);
  const [dragging, setDragging] = useState(false);

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const main = mainRef.current;
    if (!main) return;
    e.preventDefault();
    setDragging(true);
    const rect = main.getBoundingClientRect();
    const move = (ev: PointerEvent) => setLeft(((ev.clientX - rect.left) / rect.width) * 100);
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  return (
    <>
      <nav className="panel-tabs" aria-label="화면 전환">
        {PANEL_TABS.map((p) => (
          <button key={p.id} type="button" className={state.panel === p.id ? "is-active" : ""} aria-pressed={state.panel === p.id} onClick={() => dispatch({ type: "panel", panel: p.id })}>
            {p.icon}
            {p.label}
            {p.id === "C" && hasResult && state.panel !== "C" && <i className="tab-dot" aria-label="새 결과" />}
          </button>
        ))}
      </nav>
      <main className={`workspace ${dragging ? "is-dragging" : ""}`} ref={mainRef} style={{ "--split": `${left}%` } as CSSProperties}>
        <section className={`panel panel-a ${state.panel === "A" ? "is-active" : ""}`} aria-label="데이터 관리">
          <div className="panel-head">
            <div className="panel-title-row">
              <h2 className="panel-title">데이터 관리</h2>
              <span className="panel-sub">협력사 평가 요약 · 협력업체·구매조달·원가-계약·자재-공급 데이터</span>
            </div>
          </div>
          <div className="panel-body panel-body-a">
            <SupplierEvaluationCard />
            <DataManagementTabs />
          </div>
        </section>
        <div
          className="splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="데이터 관리와 분석 결과 너비 조절"
          aria-valuemin={SPLIT_MIN}
          aria-valuemax={SPLIT_MAX}
          aria-valuenow={Math.round(left)}
          tabIndex={0}
          onPointerDown={startDrag}
          onDoubleClick={() => setLeft(SPLIT_DEFAULT)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") setLeft(left - 2);
            else if (e.key === "ArrowRight") setLeft(left + 2);
            else if (e.key === "Home") setLeft(SPLIT_DEFAULT);
            else return;
            e.preventDefault();
          }}
          title="끌어서 너비 조절 · 두 번 누르면 45:55로"
        >
          <span className="splitter-grip" aria-hidden />
        </div>
        <section className={`panel panel-c ${state.panel === "C" ? "is-active" : ""}`} aria-label="분석 결과">
          <ResultPanel />
        </section>
      </main>
      <ChatWidget />
    </>
  );
}

export function App() {
  const [user, setUser] = useState<User | null>(() => currentUser());
  useEffect(() => {
    document.title = BRAND.docTitle;
  }, []);
  if (!user) return <LoginScreen onLogin={setUser} />;
  return (
    <StoreProvider key={user.id} user={user}>
      <AgentProvider>
        <div className="app">
          <Topbar
            onLogout={async (wipe) => {
              await logout(user.id, wipe);
              setUser(null);
            }}
          />
          <Workspace />
          <ImportDialog />
          <Onboarding />
          <Toast />
        </div>
      </AgentProvider>
    </StoreProvider>
  );
}
