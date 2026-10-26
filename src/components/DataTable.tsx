// 정렬·선택·페이지 나누기가 되는 데이터 표
// 정렬: 열 제목을 누를 때마다 첫 방향 → 반대 방향 → 해제 (숫자·날짜는 큰 값·최근 값이 먼저, 글자는 가나다 순)
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LuChevronLeft, LuChevronRight } from "react-icons/lu";
import type { ColumnKind, XValue } from "../lib/xlsx";
import { ScrollX } from "./ScrollX";

export interface Col<T> {
  key: string;
  label: string;
  render: (r: T) => ReactNode;
  sort?: (r: T) => string | number | null | undefined;
  num?: boolean;
  date?: boolean;
  sticky?: boolean;
  hint?: string; // 열 제목에 마우스를 올리면 보이는 용어 설명
  exp?: (r: T) => XValue; // 엑셀로 내보낼 값 (없으면 정렬 값)
  expKind?: ColumnKind;
  className?: string;
}

export type SortState = { key: string; dir: "asc" | "desc" } | null;

export const PAGE_SIZES = [20, 50, 100];

/** 위·아래 화살표를 함께 보여 주고 지금 방향만 진하게 */
export function SortIcon({ dir }: { dir: "asc" | "desc" | null }) {
  return (
    <svg className={`sort-ic ${dir ? `is-${dir}` : ""}`} viewBox="0 0 10 14" width="10" height="14" aria-hidden>
      <path className="sort-up" d="M5 1 9 5.5H1Z" />
      <path className="sort-down" d="M5 13 1 8.5h8Z" />
    </svg>
  );
}

export const firstDir = <T,>(c: Pick<Col<T>, "num" | "date">): "asc" | "desc" => (c.num || c.date ? "desc" : "asc");
const dirWord = (d: "asc" | "desc") => (d === "asc" ? "오름차순" : "내림차순");

export function sortTitle<T>(c: Col<T>, sort: SortState): string {
  const active = sort?.key === c.key;
  const first = firstDir(c);
  const next = !active ? dirWord(first) : sort!.dir === first ? dirWord(first === "asc" ? "desc" : "asc") : "정렬 해제";
  const now = active ? `${dirWord(sort!.dir)} 정렬됨 · ` : "";
  return `${c.hint ? c.hint + "\n" : ""}${now}누르면 ${next}`;
}

export function sortRowsBy<T>(rows: T[], cols: Col<T>[], sort: SortState): T[] {
  if (!sort) return rows;
  const col = cols.find((c) => c.key === sort.key);
  if (!col?.sort) return rows;
  const get = col.sort;
  return [...rows].sort((a, b) => {
    const va = get(a);
    const vb = get(b);
    if (va === vb) return 0;
    if (va === null || va === undefined || va === "") return 1;
    if (vb === null || vb === undefined || vb === "") return -1;
    const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), "ko");
    return sort.dir === "asc" ? cmp : -cmp;
  });
}

export function DataTable<T>({
  rows,
  cols,
  rowKey,
  selectedKey,
  onSelect,
  empty,
  label,
  initialSort,
  pinned,
  id,
}: {
  rows: T[];
  cols: Col<T>[];
  rowKey: (r: T) => string;
  selectedKey?: string | null;
  onSelect?: (r: T) => void;
  empty?: ReactNode;
  label: string;
  initialSort?: SortState;
  pinned?: (r: T) => boolean; // 관심 항목을 맨 위에 고정
  id?: string;
}) {
  const [sort, setSort] = useState<SortState>(initialSort ?? null);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    const s = sortRowsBy(rows, cols, sort);
    if (!pinned) return s;
    return [...s.filter(pinned), ...s.filter((r) => !pinned(r))];
  }, [rows, cols, sort, pinned]);

  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  // 선택한 행이 있으면 그 행이 있는 쪽으로, 조건·정렬이 바뀌면 첫 쪽으로
  const prevSorted = useRef(sorted);
  useEffect(() => {
    const changed = prevSorted.current !== sorted;
    prevSorted.current = sorted;
    if (selectedKey) {
      const idx = sorted.findIndex((r) => rowKey(r) === selectedKey);
      if (idx >= 0) {
        setPage(Math.floor(idx / pageSize));
        return;
      }
    }
    if (changed) setPage(0);
    else setPage((p) => Math.min(p, pages - 1));
  }, [sorted, selectedKey, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps

  const cur = Math.min(page, pages - 1);
  const shown = sorted.slice(cur * pageSize, cur * pageSize + pageSize);

  const toggle = (c: Col<T>) =>
    setSort((s) => {
      const first = firstDir(c);
      if (s?.key !== c.key) return { key: c.key, dir: first };
      if (s.dir === first) return { key: c.key, dir: first === "asc" ? "desc" : "asc" };
      return null;
    });

  return (
    <div className="dt">
      <ScrollX className="data-table-wrap">
        <table className="data-table" aria-label={label} id={id}>
          <thead>
            <tr>
              {cols.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    className={`${c.num ? "num" : ""} ${c.sticky ? "sticky-col" : ""} ${c.hint ? "has-hint" : ""} ${c.className ?? ""}`}
                    aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
                    title={c.sort ? undefined : c.hint}
                    data-col={c.key}
                  >
                    {c.sort ? (
                      <button type="button" className={`th-sort ${active ? "is-active" : ""}`} onClick={() => toggle(c)} title={sortTitle(c, sort)}>
                        {c.label}
                        <SortIcon dir={active ? sort!.dir : null} />
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const k = rowKey(r);
              const sel = k === selectedKey;
              return (
                <tr
                  key={k}
                  className={`${sel ? "is-selected" : ""} ${pinned?.(r) ? "is-pinned" : ""}`}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("button, a, input")) return;
                    onSelect?.(r);
                  }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect?.(r);
                    }
                  }}
                  tabIndex={onSelect ? 0 : undefined}
                  aria-selected={onSelect ? sel : undefined}
                >
                  {cols.map((c) => (
                    <td key={c.key} className={`${c.num ? "num" : ""} ${c.sticky ? "sticky-col" : ""} ${c.className ?? ""}`}>
                      {c.render(r)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {!sorted.length && <div className="table-empty">{empty ?? "표시할 행이 없습니다."}</div>}
      </ScrollX>
      {sorted.length > 0 && (
        <div className="pager" aria-label={`${label} 페이지`}>
          <span className="pager-range">
            {(cur * pageSize + 1).toLocaleString()}–{Math.min(sorted.length, (cur + 1) * pageSize).toLocaleString()} / {sorted.length.toLocaleString()}행
          </span>
          {pages > 1 && (
            <span className="pager-nav">
              <button type="button" className="icon-btn" onClick={() => setPage(cur - 1)} disabled={cur === 0} aria-label="이전 쪽">
                <LuChevronLeft aria-hidden />
              </button>
              <span className="pager-page">
                {cur + 1} / {pages}쪽
              </span>
              <button type="button" className="icon-btn" onClick={() => setPage(cur + 1)} disabled={cur >= pages - 1} aria-label="다음 쪽">
                <LuChevronRight aria-hidden />
              </button>
            </span>
          )}
          <label className="pager-size">
            <span>한 쪽에</span>
            <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} aria-label="한 쪽에 보일 행 수">
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}행
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
