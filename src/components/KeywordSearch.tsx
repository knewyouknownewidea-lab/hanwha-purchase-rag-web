// B 상단: 키워드 검색 — 챗봇 질문과 별도로 데이터를 바로 찾는다
import { useMemo, useRef, useState } from "react";
import { LuSearch, LuX } from "react-icons/lu";
import { search, type SearchHit } from "../lib/search";
import { useStore } from "../store/store";
import { isNarrow } from "../store/agent";

export function KeywordSearch() {
  const { derived, dispatch } = useStore();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const hits = useMemo(() => search(q, derived), [q, derived]);

  const pick = (h: SearchHit) => {
    dispatch({ type: "tab", tab: h.tab });
    dispatch({ type: "selectRow", tab: h.tab, rowKey: h.rowKey, supplierId: h.supplierId, itemCode: h.itemCode });
    if (isNarrow()) {
      dispatch({ type: "panel", panel: "A" });
      dispatch({ type: "chat", open: false });
    }
    dispatch({ type: "toast", text: `${h.tabLabel} 탭에서 '${h.title}'을(를) 선택했습니다` });
    setOpen(false);
  };

  return (
    <div
      className="kw"
      ref={boxRef}
      onBlur={(e) => {
        if (!boxRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <label className="kw-field">
        <LuSearch aria-hidden />
        <span className="sr-only">키워드 검색</span>
        <input
          id="keyword-search"
          type="search"
          role="combobox"
          aria-expanded={open && !!q}
          aria-controls="kw-results"
          placeholder="키워드 검색 · 협력사, 품목, 발주번호, 계약"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(hits.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter" && hits[active]) {
              e.preventDefault();
              pick(hits[active]);
            } else if (e.key === "Escape" && open && q) {
              e.preventDefault();
              e.nativeEvent.preventDefault();
              setOpen(false);
            }
          }}
        />
        {q && (
          <button type="button" className="kw-clear" onClick={() => setQ("")} aria-label="검색어 지우기">
            <LuX aria-hidden />
          </button>
        )}
      </label>
      {open && q.trim() && (
        <div className="kw-results" id="kw-results" role="listbox" aria-label="검색 결과">
          <p className="kw-count">{hits.length ? `${hits.length}건${hits.length >= 40 ? " 이상" : ""} · 누르면 데이터 관리에서 선택됩니다` : "일치하는 데이터가 없습니다"}</p>
          {hits.map((h, i) => (
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              key={h.key}
              className={`kw-hit ${i === active ? "is-active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(h)}
            >
              <span className="kw-src">{h.source}</span>
              <span className="kw-title">{h.title}</span>
              <span className="kw-sub">{h.subtitle}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
