// 분석 이력: 지난 결과를 이름·질문으로 찾고, 다시 보기·이름 바꾸기·고정·삭제
import { useEffect, useMemo, useRef, useState } from "react";
import { LuCheck, LuPencil, LuPin, LuPinOff, LuSearch, LuTrash2, LuX } from "react-icons/lu";
import { MAX_RESULTS, resultName, useStore } from "../store/store";
import { useAgent } from "../store/agent";
import { templateLabel } from "../templates/registry";
import type { AnalysisResult } from "../lib/analysisTypes";

const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export function HistoryPanel({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const { choose } = useAgent();
  const [q, setQ] = useState("");
  const [order, setOrder] = useState<"new" | "name">("new");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [askDel, setAskDel] = useState<string | null>(null); // 삭제는 한 번 더 확인한다 (되돌릴 수 없음)
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(t) && !t.closest(".history-toggle")) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && askDel) {
        e.preventDefault();
        e.stopPropagation();
        setAskDel(null);
        return;
      }
      if (e.key === "Escape" && !editing) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose, editing, askDel]);

  const list = useMemo(() => {
    const all = Object.values(state.results);
    const t = q.trim().toLowerCase();
    const hit = (r: AnalysisResult) => !t || [resultName(state, r), r.question, r.title, r.kindLabel].join(" ").toLowerCase().includes(t);
    const out = all.filter(hit);
    out.sort((a, b) => {
      const pa = state.resultMeta[a.id]?.pinned ? 0 : 1;
      const pb = state.resultMeta[b.id]?.pinned ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return order === "new" ? b.createdAt.localeCompare(a.createdAt) : resultName(state, a).localeCompare(resultName(state, b), "ko");
    });
    return out;
  }, [state, q, order]);

  const total = Object.keys(state.results).length;
  const saveName = (id: string) => {
    dispatch({ type: "renameResult", id, name: draft });
    setEditing(null);
  };

  return (
    <div className="popover history-pop" ref={ref} role="dialog" aria-label="분석 이력" id="history-panel">
      <div className="pop-head">
        <div>
          <h3>분석 이력</h3>
          <p className="muted small">
            {total}건 저장 · 최대 {MAX_RESULTS}건, 넘으면 고정하지 않은 오래된 결과부터 지웁니다
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="분석 이력 닫기">
          <LuX aria-hidden />
        </button>
      </div>
      <div className="history-tools">
        <label className="search-field">
          <LuSearch aria-hidden />
          <span className="sr-only">이력 검색</span>
          <input ref={searchRef} id="history-q" type="search" placeholder="결과 이름·질문으로 찾기" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="seg-ctl" role="radiogroup" aria-label="정렬">
          <button type="button" role="radio" aria-checked={order === "new"} className={order === "new" ? "is-on" : ""} onClick={() => setOrder("new")}>
            최신순
          </button>
          <button type="button" role="radio" aria-checked={order === "name"} className={order === "name" ? "is-on" : ""} onClick={() => setOrder("name")}>
            이름순
          </button>
        </div>
      </div>
      <ul className="history-list">
        {list.map((r) => {
          const pinned = !!state.resultMeta[r.id]?.pinned;
          const stale = r.dataId !== state.meta.dataId;
          const current = state.view.resultId === r.id;
          return (
            <li key={r.id} className={`history-item ${current ? "is-current" : ""}`}>
              {editing === r.id ? (
                <form
                  className="history-rename"
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveName(r.id);
                  }}
                >
                  <input
                    autoFocus
                    value={draft}
                    maxLength={60}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        setEditing(null);
                      }
                    }}
                    aria-label="결과 이름"
                    id="history-rename-input"
                  />
                  <button type="submit" className="icon-btn" aria-label="이름 저장">
                    <LuCheck aria-hidden />
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  className="history-open"
                  onClick={() => {
                    choose(r.id, state.view.template && r.templates.includes(state.view.template) ? state.view.template : r.recommended);
                    onClose();
                  }}
                  title="결과창에 표시"
                >
                  <span className="history-name">
                    {pinned && <LuPin aria-label="고정됨" />} {resultName(state, r)}
                  </span>
                  <span className="history-q">{r.question}</span>
                  <span className="history-meta">
                    <span>{when(r.createdAt)}</span>
                    <span>{r.kindLabel}</span>
                    <span>추천 {templateLabel(r.recommended)}</span>
                    <span>{r.dataLabel.includes("업로드") ? "업로드 데이터" : "SAMPLE"}</span>
                    {stale && <span className="pill pill-warn">다시 분석 필요</span>}
                    {current && <span className="pill pill-info">보는 중</span>}
                  </span>
                </button>
              )}
              {askDel === r.id ? (
                <span className="history-confirm" role="group" aria-label="삭제 확인">
                  <span>이력에서 지울까요?</span>
                  <button
                    type="button"
                    className="btn btn-danger btn-small history-del-yes"
                    autoFocus
                    onClick={() => {
                      dispatch({ type: "deleteResult", id: r.id });
                      dispatch({ type: "toast", text: `'${resultName(state, r)}' 결과를 이력에서 지웠습니다` });
                      setAskDel(null);
                    }}
                  >
                    삭제
                  </button>
                  <button type="button" className="btn btn-quiet btn-small" onClick={() => setAskDel(null)}>
                    취소
                  </button>
                </span>
              ) : (
              <span className="history-actions">
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => {
                    setEditing(r.id);
                    setDraft(resultName(state, r));
                  }}
                  aria-label={`${resultName(state, r)} 이름 바꾸기`}
                  title="이름 바꾸기"
                >
                  <LuPencil aria-hidden />
                </button>
                <button type="button" className={`icon-btn ${pinned ? "is-on" : ""}`} onClick={() => dispatch({ type: "pinResult", id: r.id, pinned: !pinned })} aria-label={pinned ? "고정 해제" : "고정 (자동 삭제에서 제외)"} title={pinned ? "고정 해제" : "고정 (자동 삭제에서 제외)"} aria-pressed={pinned}>
                  {pinned ? <LuPinOff aria-hidden /> : <LuPin aria-hidden />}
                </button>
                <button type="button" className="icon-btn danger" onClick={() => setAskDel(r.id)} aria-label={`${resultName(state, r)} 삭제`} title="삭제">
                  <LuTrash2 aria-hidden />
                </button>
              </span>
              )}
            </li>
          );
        })}
        {!list.length && <li className="table-empty">{total ? "검색어와 맞는 결과가 없습니다." : "아직 분석 결과가 없습니다. AI에게 질문하면 결과가 여기에 쌓입니다."}</li>}
      </ul>
    </div>
  );
}
