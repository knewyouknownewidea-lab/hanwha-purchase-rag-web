// 템플릿 ④ 분석 보고서 — 인쇄(로컬) 또는 HTML 저장(claude.ai)용 문서 (섹션·요약형/상세형은 보기 설정)
import { forwardRef, type ReactNode } from "react";
import type { ReportSection } from "../../templates/presets";
import { formatCell, isNumericKind } from "../ui";
import { ScrollX } from "../ScrollX";
import { fmtSignedPct } from "../../lib/format";
import { formatPriceAmount, formatPriceDifference, PriceBenchmarkInfo, PriceConditionsInfo, PriceAnalysisDocuments, PriceIndicators, type PriceTemplateProps } from "./PriceComparisonInfo";

export const AnalysisReport = forwardRef<HTMLElement, PriceTemplateProps>(function AnalysisReport({ result, settings, onExternalQuoteChange }, ref) {
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

  const legacySections: { id: ReportSection; title: string; body: ReactNode; show: boolean }[] = [
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
  const price = result.priceAnalysis;
  const priceRows = price ? cut(price.rows, 5) : [];
  const currency = price?.conditions.currency;
  const sections = price ? [
    {
      id: "purpose" as const, title: "선택 품목과 비교 대상", show: true,
      body: <>
        <p>{price.item.name} ({price.item.itemCode}) · 규격 {price.item.spec ?? "미확인"} · 단위 {price.item.unit ?? "미확인"}</p>
        <p>비교 협력사: {price.rows.map((row) => row.supplierName).join(", ") || "없음"} · 기준일 {price.asOf} · {price.dataLabel}</p>
        <p className="small muted">분석 식별자 {price.id} · 가격 분석 버전 {price.revision} · 데이터 {price.dataId} / 버전 {price.dataVersion}</p>
        <p>등록 협력사 가격 기록과 외부 완성부품 견적은 별도 데이터입니다. 가상 견적은 실제 거래자료로 해석하지 않습니다.</p>
      </>,
    },
    {
      id: "basis" as const, title: "시장 참고가격의 출처와 산정 방식", show: true,
      body: <>
        <PriceBenchmarkInfo analysis={price} onExternalQuoteChange={onExternalQuoteChange} expanded />
        <p><b>외부 API 참고 정보</b></p>
        <PriceIndicators indicators={price.indicators} />
      </>,
    },
    {
      id: "comparison" as const, title: "협력사별 차액과 차이율", show: true,
      body: <>
        <p>차액 = 협력사 단가 − 시장 참고가격 · 차이율 = 차액 ÷ 시장 참고가격 × 100</p>
        <ScrollX><table aria-label="보고서 협력사 가격 비교"><thead><tr><th>협력사</th><th className="num">협력사 단가</th><th className="num">시장 참고가격</th><th className="num">차액</th><th className="num">차이율</th><th>비교 상태 · 확인 사유</th></tr></thead>
          <tbody>{priceRows.map((row) => <tr key={row.supplierId}>
            <td>{row.supplierName}</td><td className="num">{formatPriceAmount(row.supplierPrice, row.record?.conditions.currency)}</td><td className="num">{formatPriceAmount(row.benchmark, currency)}</td>
            <td className="num">{formatPriceDifference(row.delta, currency)}</td><td className="num">{fmtSignedPct(row.deltaPct)}</td>
            <td>{row.statusLabel}{row.reasons.length ? ` · ${row.reasons.join(" · ")}` : ""}</td>
          </tr>)}</tbody></table></ScrollX>
        {price.rows.length > priceRows.length && <p className="small muted">앞 {priceRows.length}개만 표시 · 전체는 상세형 또는 협력사 비교표에서 확인합니다.</p>}
        <p>시장 참고가격 대비 차이는 가격 재검토의 참고 정보입니다. 높은 단가만으로 부당한 가격이라고 단정하지 않습니다.</p>
      </>,
    },
    {
      id: "scope" as const, title: "비교 조건 일치 여부", show: true,
      body: <PriceConditionsInfo analysis={price} />,
    },
    {
      id: "results" as const, title: "문서에서 확인된 차이 사유", show: true,
      body: <><PriceAnalysisDocuments analysis={price} /><p className="small muted">문서에 기록된 요구사항만 표시합니다. 평가점수나 등급으로 가격 차이 사유를 추정하지 않습니다.</p></>,
    },
    {
      id: "review" as const, title: "추가 확인이 필요한 사항", show: true,
      body: <>
        <ul>
          {price.rows.filter((row) => row.status !== "comparable").map((row) => <li key={row.supplierId}>{row.supplierName}: {row.statusLabel} · {row.reasons.join(" · ") || "비교 조건 확인 필요"}</li>)}
          {price.benchmark.reasons.map((reason) => <li key={reason}>{reason}</li>)}
          {cut(result.reviewPoints, 3).map((point) => <li key={point}>{point}</li>)}
          <li>가격 차이의 사유는 계약·견적·검사·납품 조건 자료로 추가 확인합니다. 최종 선정과 조치는 담당자가 검토 후 확정합니다.</li>
        </ul>
        {price.notes.length > 0 && <p className="small muted">{price.notes.join(" · ")}</p>}
      </>,
    },
  ] : legacySections;
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
