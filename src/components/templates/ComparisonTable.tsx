// 템플릿 ① 협력사 비교표: 정렬 가능한 표 + 요약·위험·근거 (열·간격·정렬·표시 옵션은 보기 설정)
import { useEffect, useMemo, useState } from "react";
import { SortIcon as SortArrows } from "../DataTable";
import type { AnalysisResult, ResultColumn, ResultRow } from "../../lib/analysisTypes";
import { resolveColumns, type ViewSettings } from "../../templates/presets";
import { formatCell, isNumericKind } from "../ui";
import { Findings, Highlights } from "./shared";
import { ScrollX } from "../ScrollX";

function bestIds(result: AnalysisResult, col: ResultColumn) {
  if (col.higherIsBetter === undefined) return new Set<string>();
  const rows = result.rows.filter((r) => !r.excludedReason && r.values[col.key] !== null && r.values[col.key] !== undefined);
  if (rows.length < 2) return new Set<string>();
  const vals = rows.map((r) => Number(r.values[col.key]));
  const target = col.higherIsBetter ? Math.max(...vals) : Math.min(...vals);
  return new Set(rows.filter((r) => Number(r.values[col.key]) === target).map((r) => r.id));
}

type Sort = { key: string; dir: "asc" | "desc" } | null;

export function sortRows(rows: ResultRow[], sort: Sort): ResultRow[] {
  if (!sort) return rows;
  const get = (r: ResultRow) => (sort.key === "__rank" ? r.rank ?? 999 : sort.key === "__label" ? r.label : r.values[sort.key]);
  return [...rows].sort((a, b) => {
    const va = get(a);
    const vb = get(b);
    if (va === vb) return 0;
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), "ko");
    return sort.dir === "asc" ? cmp : -cmp;
  });
}

export function ComparisonTable({ result, settings }: { result: AnalysisResult; settings: ViewSettings }) {
  const t = settings.table;
  const cols = resolveColumns(result, t.columns);
  const hasRank = result.rows.some((r) => r.rank);
  const baseSort: Sort = t.sort && (t.sort.key === "__rank" ? hasRank : t.sort.key === "__label" || result.columns.some((c) => c.key === t.sort!.key)) ? t.sort : hasRank ? { key: "__rank", dir: "asc" } : null;
  const [sort, setSort] = useState<Sort>(baseSort);
  useEffect(() => setSort(baseSort), [result.id, t.sort?.key, t.sort?.dir]); // eslint-disable-line react-hooks/exhaustive-deps
  const best = useMemo(() => new Map(result.columns.map((c) => [c.key, bestIds(result, c)])), [result]);
  const visible = t.showExcluded ? result.rows : result.rows.filter((r) => !r.excludedReason);
  const rows = useMemo(() => sortRows(visible, sort), [visible, sort]);
  const hidden = result.rows.length - visible.length;

  // 데이터 관리 표와 같은 규칙: 첫 방향(숫자는 큰 값부터, 글자·검토 순서는 작은 값부터) → 반대 방향 → 기본 순서
  const firstOf = (key: string, numeric: boolean): "asc" | "desc" => (numeric && key !== "__rank" ? "desc" : "asc");
  const backToBase = (key: string, dir: "asc" | "desc", numeric: boolean) => dir !== firstOf(key, numeric) && !!baseSort && baseSort.key !== key;
  const toggle = (key: string, numeric: boolean) =>
    setSort((s) => {
      if (s?.key !== key) return { key, dir: firstOf(key, numeric) };
      if (backToBase(key, s.dir, numeric)) return baseSort;
      return { key, dir: s.dir === "asc" ? "desc" : "asc" };
    });
  const ariaSort = (k: string) => (sort?.key === k ? (sort.dir === "asc" ? "ascending" : "descending") : "none");
  const SortIcon = ({ k }: { k: string }) => <SortArrows dir={sort?.key === k ? sort.dir : null} />;
  const word = (d: "asc" | "desc") => (d === "asc" ? "오름차순" : "내림차순");
  const sortHint = (k: string, numeric: boolean) =>
    sort?.key === k ? `${word(sort.dir)} 정렬됨 · 누르면 ${backToBase(k, sort.dir, numeric) ? "기본 순서" : word(sort.dir === "asc" ? "desc" : "asc")}` : `누르면 ${word(firstOf(k, numeric))}`;

  return (
    <div className="tpl tpl-table">
      <Highlights result={result} />
      <p className="tpl-note">
        {rows.length}개 대상{hidden ? ` (순위 제외 ${hidden}개 숨김)` : ""} · 열 제목을 누르면 정렬 · 열 선택과 행 간격은 ‘보기 설정’
        {t.showBest && (
          <>
            {" "}
            · <span className="best-mark">최고</span> 비교 가능한 대상 중 가장 좋은 값
          </>
        )}
      </p>
      <ScrollX>
        <table className={`result-table ${t.density === "compact" ? "is-compact" : ""}`}>
          <thead>
            <tr>
              {hasRank && (
                <th className="num rank-col" aria-sort={ariaSort("__rank")}>
                  <button type="button" className={`th-sort ${sort?.key === "__rank" ? "is-active" : ""}`} onClick={() => toggle("__rank", true)} title={sortHint("__rank", true)}>
                    {result.rankLabel ?? "순서"}
                    <SortIcon k="__rank" />
                  </button>
                </th>
              )}
              <th className="sticky-col" aria-sort={ariaSort("__label")}>
                <button type="button" className={`th-sort ${sort?.key === "__label" ? "is-active" : ""}`} onClick={() => toggle("__label", false)} title={sortHint("__label", false)}>
                  대상
                  <SortIcon k="__label" />
                </button>
              </th>
              {cols.map((c) => (
                <th key={c.key} className={isNumericKind(c) ? "num" : ""} aria-sort={ariaSort(c.key)}>
                  <button type="button" className={`th-sort ${sort?.key === c.key ? "is-active" : ""}`} onClick={() => toggle(c.key, isNumericKind(c))} title={sortHint(c.key, isNumericKind(c))}>
                    {c.label}
                    <SortIcon k={c.key} />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.excludedReason ? "is-excluded" : undefined}>
                {hasRank && <td className="num rank-cell">{r.rank ?? "–"}</td>}
                <td className="sticky-col">
                  <span className="name-cell">
                    <span className="name">{r.label}</span>
                    {r.excludedReason ? <span className="cond-flag">조건 상이 · 순위 제외</span> : r.sub ? <span className="code">{r.sub}</span> : null}
                  </span>
                </td>
                {cols.map((c) => {
                  const isBest = t.showBest && best.get(c.key)?.has(r.id);
                  return (
                    <td key={c.key} className={`${isNumericKind(c) ? "num" : ""} ${isBest ? "is-best" : ""}`}>
                      {formatCell(c.kind, r.values[c.key], r.currency, c.digits)}
                      {isBest && <span className="best-mark">최고</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollX>
      {result.rows.some((r) => r.excludedReason) && (
        <p className="tpl-note">
          조건 상이: {result.rows.filter((r) => r.excludedReason).map((r) => `${r.label}(${r.excludedReason})`).join(", ")} — 단순 가격 순위에 넣지 않았습니다.
        </p>
      )}
      <Findings result={result} />
    </div>
  );
}
