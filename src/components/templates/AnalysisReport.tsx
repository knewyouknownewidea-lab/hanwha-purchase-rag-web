// 템플릿 ④ 분석 보고서 — 인쇄(로컬) 또는 HTML 저장(claude.ai)용 문서 (섹션·요약형/상세형은 보기 설정)
import { forwardRef, type ReactNode } from "react";
import type { AnalysisResult } from "../../lib/analysisTypes";
import type { ReportSection, ViewSettings } from "../../templates/presets";
import { formatCell, isNumericKind } from "../ui";
import { ScrollX } from "../ScrollX";

export const AnalysisReport = forwardRef<HTMLElement, { result: AnalysisResult; settings: ViewSettings }>(function AnalysisReport({ result, settings }, ref) {
  const rs = settings.report;
  const brief = rs.mode === "summary";
  const cols = result.columns.filter((c) => c.primary);
  const hasRank = result.rows.some((r) => r.rank);
  const created = new Date(result.createdAt);
  const cut = <T,>(xs: T[], n: number) => (brief ? xs.slice(0, n) : xs);
  const rows = cut(
    [...result.rows].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999)),
    5,
  );

  const sections: { id: ReportSection; title: string; body: ReactNode; show: boolean }[] = [
    {
      id: "purpose",
      title: "분석 목적",
      show: true,
      body: (
        <>
          <p>{result.purpose}</p>
          {!brief && <p className="muted small">요청 질문: “{result.question}”</p>}
        </>
      ),
    },
    {
      id: "scope",
      title: "분석 조건 · 대상 및 데이터 범위",
      show: true,
      body: (
        <table>
          <tbody>
            {result.scope.map((s) => (
              <tr key={s.label}>
                <th scope="row">{s.label}</th>
                <td>{s.value}</td>
              </tr>
            ))}
            <tr>
              <th scope="row">사용 데이터</th>
              <td>
                {result.sources
                  .filter((s) => s.ids.length)
                  .map((s) => `${s.label} ${s.ids.length}건`)
                  .join(" · ")}
              </td>
            </tr>
          </tbody>
        </table>
      ),
    },
    {
      id: "results",
      title: "주요 분석 결과",
      show: true,
      body: (
        <ul>
          {cut(result.summary, 3).map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      ),
    },
    {
      id: "comparison",
      title: "비교 결과",
      show: true,
      body: (
        <>
          <ScrollX>
            <table>
              <thead>
                <tr>
                  {hasRank && <th className="num">{result.rankLabel ?? "순서"}</th>}
                  <th>대상</th>
                  {cols.map((c) => (
                    <th key={c.key} className={isNumericKind(c) ? "num" : ""}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    {hasRank && <td className="num">{r.rank ?? "제외"}</td>}
                    <td>
                      {r.label}
                      {r.excludedReason ? ` (조건 상이: ${r.excludedReason})` : ""}
                    </td>
                    {cols.map((c) => (
                      <td key={c.key} className={isNumericKind(c) ? "num" : ""}>
                        {c.kind === "grade" ? String(r.values[c.key] ?? "–") : formatCell(c.kind, r.values[c.key], r.currency, c.digits)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollX>
          {brief && result.rows.length > rows.length && <p className="muted small">상위 {rows.length}개만 표시 · 전체는 상세형 또는 협력사 비교표에서 확인</p>}
        </>
      ),
    },
    {
      id: "risks",
      title: "위험 요소",
      show: result.risks.length > 0,
      body: (
        <ul>
          {cut(result.risks, 3).map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      ),
    },
    {
      id: "review",
      title: "검토 의견 (초안)",
      show: true,
      body: (
        <ul>
          {cut(result.reviewPoints, 3).map((s) => (
            <li key={s}>{s}</li>
          ))}
          <li>이 보고서는 기록된 데이터로 계산한 비교 결과입니다. 최종 선정과 조치는 담당자가 검토 후 확정합니다.</li>
        </ul>
      ),
    },
    {
      id: "basis",
      title: "사용된 평가 근거 · 참조 데이터",
      show: true,
      body: (
        <>
          <ul>
            {result.basis.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          {result.notes.length > 0 && <p className="muted small">참고: {result.notes.join(" · ")}</p>}
          {!brief && (
            <p className="muted small">
              참조 레코드:{" "}
              {result.sources
                .filter((s) => s.ids.length)
                .map((s) => `${s.label} ${s.ids.slice(0, 6).join(", ")}${s.ids.length > 6 ? ` 외 ${s.ids.length - 6}건` : ""}`)
                .join(" / ")}
            </p>
          )}
        </>
      ),
    },
  ];
  const shown = sections.filter((s) => s.show && rs.sections[s.id]);

  return (
    <article className={`tpl report-doc ${brief ? "is-brief" : ""}`} ref={ref}>
      <header className="report-head">
        <p className="report-kicker">
          분석 보고서 · {result.kindLabel} · {brief ? "요약형" : "상세형"}
        </p>
        <h1>{result.title}</h1>
        <p className="muted small">
          작성: AI 분석 도우미 초안 · {created.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })} · 데이터 기준일 {result.asOf} · {result.dataLabel}
        </p>
      </header>
      {shown.map((s, i) => (
        <section key={s.id} data-section={s.id}>
          <h2>
            {i + 1}. {s.title}
          </h2>
          {s.body}
        </section>
      ))}
      {!shown.length && <p className="muted">보기 설정에서 포함할 섹션을 하나 이상 선택해 주세요.</p>}
    </article>
  );
});
