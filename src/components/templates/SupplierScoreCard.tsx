// 템플릿 ③ 종합 평가 카드 — 대상별 점수, 강점, 위험 요소, 근거 (한 줄 개수·지표·정렬·펼침은 보기 설정)
import { LuCircleAlert, LuCircleCheck } from "react-icons/lu";
import type { AnalysisResult } from "../../lib/analysisTypes";
import { resolveMetrics, type ViewSettings } from "../../templates/presets";
import { formatCell, GradeBadge } from "../ui";
import { fmtNum } from "../../lib/format";
import { Highlights } from "./shared";
import { sortRows } from "./ComparisonTable";

export function SupplierScoreCard({ result, settings }: { result: AnalysisResult; settings: ViewSettings }) {
  const cs = settings.cards;
  const colOf = (k: string) => result.columns.find((c) => c.key === k);
  const metrics = resolveMetrics(result, cs.metrics);
  const sortCol = colOf(cs.sort);
  const hasRank = result.rows.some((r) => r.rank);
  const auto =
    cs.sort === "__label"
      ? { key: "__label", dir: "asc" as const }
      : sortCol
        ? { key: sortCol.key, dir: sortCol.higherIsBetter === false ? ("asc" as const) : ("desc" as const) }
        : hasRank
          ? { key: "__rank", dir: "asc" as const }
          : null;
  const sort = auto && cs.sortDir && cs.sortDir !== "auto" ? { ...auto, dir: cs.sortDir } : auto;
  const rows = sortRows(result.rows, sort);
  const limit = cs.expand ? 99 : 2;
  return (
    <div className="tpl tpl-cards">
      <Highlights result={result} />
      <div className={`score-cards per-${cs.perRow}`}>
        {rows.map((r) => {
          const grade = r.values.grade as string | null | undefined;
          const score = r.values.score ?? r.values.total;
          const moreS = r.strengths.length - limit;
          const moreR = r.risks.length - limit;
          return (
            <article key={r.id} className={`score-card ${r.rank === 1 ? "is-top" : ""} ${r.excludedReason ? "is-excluded" : ""}`}>
              <header>
                <div>
                  <h4>{r.label}</h4>
                  {r.sub && <span className="code">{r.sub}</span>}
                </div>
                <div className="score-card-badges">
                  {r.rank ? <span className="rank-badge">{result.rankLabel ?? "순서"} {r.rank}</span> : r.excludedReason ? <span className="cond-flag">순위 제외</span> : null}
                  {grade !== undefined && <GradeBadge grade={grade} size="md" />}
                </div>
              </header>
              {score !== undefined && score !== null && (
                <p className="score-line">
                  <span className="score-num">{fmtNum(Number(score))}</span>
                  <span className="muted">{r.values.score !== undefined ? "검토 점수" : "종합 점수"}</span>
                </p>
              )}
              <dl className="card-metrics">
                {metrics.map((k) => {
                  const c = colOf(k);
                  if (!c) return null;
                  return (
                    <div key={k}>
                      <dt>{c.label}</dt>
                      <dd>{formatCell(c.kind, r.values[k], r.currency, c.digits)}</dd>
                    </div>
                  );
                })}
              </dl>
              {r.strengths.length > 0 && (
                <ul className="pros" aria-label="강점">
                  {r.strengths.slice(0, limit).map((s) => (
                    <li key={s}>
                      <LuCircleCheck aria-hidden /> {s}
                    </li>
                  ))}
                  {moreS > 0 && <li className="more">강점 {moreS}개 더</li>}
                </ul>
              )}
              {r.risks.length > 0 && (
                <ul className="cons" aria-label="위험 요소">
                  {r.risks.slice(0, limit).map((s) => (
                    <li key={s}>
                      <LuCircleAlert aria-hidden /> {s}
                    </li>
                  ))}
                  {moreR > 0 && <li className="more">위험 요소 {moreR}개 더</li>}
                </ul>
              )}
              {r.evidence.length > 0 && (
                <details className="evidence" open={cs.expand}>
                  <summary>관련 평가 근거</summary>
                  <ul>
                    {r.evidence.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </details>
              )}
            </article>
          );
        })}
      </div>
      <p className="tpl-note">카드 순서와 점수는 검토용 참고값입니다. 강점·위험 요소를 모두 보려면 보기 설정에서 ‘모두 펼침’을 고르세요. 최종 선정과 판단은 담당자가 검토 후 확정합니다.</p>
    </div>
  );
}
