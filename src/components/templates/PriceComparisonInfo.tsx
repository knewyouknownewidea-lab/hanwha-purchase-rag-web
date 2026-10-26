// 기존 결과 템플릿 안에서 공통 가격 분석·견적 출처를 표시한다. 계산은 priceComparison 계층에서만 수행한다.
import { useEffect, useState } from "react";
import type { AnalysisResult } from "../../lib/analysisTypes";
import type { ViewSettings } from "../../templates/presets";
import type { MarketIndicator, PriceAnalysis, PriceConditions, PriceEvidence, PriceSource } from "../../lib/priceComparison";
import { PRICE_CONDITION_LABELS as CONDITION_LABELS, PRICE_STATUS_LABEL } from "../../lib/priceComparison";
import { fmtMoney, fmtNum } from "../../lib/format";
import { ScrollX } from "../ScrollX";

export type ExternalQuoteChange = (quoteId: string, unitPrice: number) => void;
export interface PriceTemplateProps {
  result: AnalysisResult;
  settings: ViewSettings;
  onExternalQuoteChange?: ExternalQuoteChange;
}
export const formatPriceAmount = (value: number | null, currency?: string | null) => value === null ? "–" : currency ? fmtMoney(value, currency) : `${fmtNum(value)} (통화 미확인)`;
export const formatPriceDifference = (value: number | null, currency?: string | null) => value === null ? "–" : `${value > 0 ? "+" : ""}${formatPriceAmount(value, currency)}`;

function QuotePriceInput({ id, value, onChange }: { id: string; value: number | null; onChange: ExternalQuoteChange }) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const [error, setError] = useState(false);
  useEffect(() => { setDraft(value === null ? "" : String(value)); setError(false); }, [value]);
  const commit = () => {
    const next = Number(draft);
    if (!draft.trim() || !Number.isFinite(next) || next < 0) { setError(true); return; }
    setError(false);
    if (next !== value) onChange(id, next);
  };
  return <>
    <input type="number" min={0} step="any" value={draft} aria-label={`${id} 외부 견적 단가`} data-external-quote-id={id} aria-invalid={error || undefined}
      onChange={(event) => { setDraft(event.target.value); setError(false); }} onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} />
    {error && <p className="note-bad" role="alert">0 이상의 숫자로 입력해 주세요.</p>}
  </>;
}

export const PRICE_CONDITION_LABELS = Object.entries(CONDITION_LABELS) as [keyof PriceConditions, string][];
const known = (value: string | number | null | undefined) => value === null || value === undefined || value === "" ? "미확인" : String(value);
function httpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}

export function PriceSourceReference({ source }: { source: PriceSource }) {
  const url = httpUrl(source.url);
  return <>
    {url ? <a href={url} target="_blank" rel="noopener noreferrer">{source.title}</a> : <span>{source.title}</span>}
    <span className="small muted"> · {source.date || "날짜 미확인"} · {source.page ? `페이지 ${source.page} · ` : ""}식별자 {source.documentId}</span>
  </>;
}

export function PriceDocuments({ evidence }: { evidence: PriceEvidence[] }) {
  if (!evidence.length) return <p>관련 근거를 찾지 못함</p>;
  return <ul>{evidence.map((document) => <li key={document.id}>
    <p><b>{document.title}</b> · {document.date || "날짜 미확인"}{document.page ? ` · 페이지 ${document.page}` : ""} · 식별자 {document.id}{document.isSample ? " · 가상 문서" : ""}</p>
    <p className="small muted">품목 {document.itemCode} · 협력사 {document.supplierIds.length ? document.supplierIds.join(", ") : "특정 협력사 지정 없음"} · 관련 기록 {document.recordIds.join(", ") || "미확인"}</p>
    <p>{document.text}</p>
  </li>)}</ul>;
}

export function PriceAnalysisDocuments({ analysis }: { analysis: PriceAnalysis }) {
  return <>
    <PriceDocuments evidence={analysis.evidence} />
    {analysis.evidence.length > 0 && analysis.rows.filter((row) => !row.evidence.length).map((row) => <p key={row.supplierId}>{row.supplierName}: 관련 근거를 찾지 못함</p>)}
  </>;
}

export function PriceConditionsInfo({ analysis }: { analysis: PriceAnalysis }) {
  return <>
    <ScrollX><table className="mini-table" aria-label="가격 비교 기준 조건"><tbody>
      {PRICE_CONDITION_LABELS.map(([field, label]) => <tr key={field}><th scope="row">{label}</th><td>{known(analysis.conditions[field])}</td></tr>)}
    </tbody></table></ScrollX>
    <ul>{analysis.rows.map((row) => <li key={row.supplierId}>
      <b>{row.supplierName}</b> · {row.statusLabel}{row.reasons.length ? ` · ${row.reasons.join(" · ")}` : row.status === "comparable" ? " · 확인된 비교 조건 일치" : " · 비교 조건 추가 확인 필요"}
      {row.checks.some((check) => check.status !== "comparable") && <p className="small muted">{row.checks.filter((check) => check.status !== "comparable").map((check) => `${check.label}: ${check.reason}`).join(" · ")}</p>}
    </li>)}</ul>
    <p className="small muted">누락된 조건은 일치로 간주하지 않습니다. 확인되지 않은 원가 보정값은 적용하지 않습니다.</p>
  </>;
}

const API_STATUS: Record<string, string> = {
  connected: "실제 API 조회", succeeded: "실제 API 조회", unavailable: "API 조회 실패", failed: "API 조회 실패",
  not_configured: "API 미연결", unconfigured: "API 미연결", example: "API 예시 데이터", loading: "API 조회 중",
};
export function PriceIndicators({ indicators }: { indicators: MarketIndicator[] }) {
  return <>
    {!indicators.length ? <p>API 미연결 · 외부 참고 지표가 등록되지 않았습니다.</p> : <ScrollX><table className="mini-table" aria-label="외부 API 참고 정보">
      <thead><tr><th>참고 지표</th><th>연결 상태</th><th>조회값 · 단위 · 통화</th><th>출처</th><th>관측 기준일 · 조회 시각</th><th>안내</th></tr></thead>
      <tbody>{indicators.map((indicator) => {
        const url = httpUrl(indicator.sourceUrl);
        const showValue = ["connected", "succeeded", "example"].includes(indicator.status);
        return <tr key={indicator.id} data-indicator-id={indicator.id}>
          <td>{indicator.label}</td><td>{API_STATUS[indicator.status] ?? "API 상태 확인 필요"}</td>
          <td className="num">{showValue && indicator.value !== null ? fmtNum(indicator.value, 2) : "–"} · {indicator.unit || "단위 미확인"}{indicator.currency ? ` · ${indicator.currency}` : ""}</td>
          <td>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{indicator.source || "출처"}</a> : indicator.source || "출처 미확인"}</td>
          <td>{indicator.observedAt || "관측일 미확인"}<br />{indicator.fetchedAt || "조회 시각 없음"}</td><td>{indicator.message}</td>
        </tr>;
      })}</tbody>
    </table></ScrollX>}
    <p className="small muted">원자재·환율·가격지수는 시장 상황의 참고 정보입니다. 완성부품의 시장 참고가격이나 가격 보정값으로 대체하지 않습니다.</p>
  </>;
}

export function PriceBenchmarkInfo({ analysis, onExternalQuoteChange, expanded = false }: { analysis: PriceAnalysis; onExternalQuoteChange?: ExternalQuoteChange; expanded?: boolean }) {
  const benchmark = analysis.benchmark;
  const currency = analysis.conditions.currency;
  const unit = analysis.conditions.unit ?? analysis.item.unit ?? "단위 미확인";
  return <>
    <p data-market-reference>시장 참고가격 {benchmark.median === null ? "계산 불가" : `${formatPriceAmount(benchmark.median, currency)}/${unit}`} · 유효 외부 완성부품 견적 {benchmark.count}건 · 가격 범위 {formatPriceAmount(benchmark.min, currency)} ~ {formatPriceAmount(benchmark.max, currency)} · {analysis.dataLabel}</p>
    <p className="small muted">분석 식별자 {analysis.id} · 가격 분석 버전 {analysis.revision} · 데이터 {analysis.dataId} / 버전 {analysis.dataVersion}</p>
    <p className="small muted">산정 방식: 비교 조건을 충족한 외부 완성부품 견적 단가의 중앙값. 등록 협력사 평균이나 원자재 가격은 사용하지 않습니다.</p>
    {analysis.rows.some((row) => row.record?.kind === "supplier_quote" && row.record.isSample) && <p className="small muted">협력사 비교 단가는 별도의 가상 신규 견적입니다. 기존 계약 단가·평가점수는 변경하지 않았습니다.</p>}
    {benchmark.reasons.length > 0 && <p className="note-warn">{benchmark.reasons.join(" · ")}</p>}
    <details className="evidence" data-external-quotes open={expanded || undefined}>
      <summary>외부 완성부품 견적 {analysis.externalQuotes.length}건 · 가격 근거와 비교 조건</summary>
      {onExternalQuoteChange && <p className="small muted">견적 단가를 바꾼 뒤 Enter를 누르거나 다른 곳을 누르면 모든 결과에 반영합니다. 0은 유효한 시장 참고가격으로 사용하지 않습니다.</p>}
      <ScrollX><table className="mini-table" aria-label="외부 완성부품 견적">
        <thead><tr><th>외부 견적</th><th className="num">견적 단가</th><th>수량 · 단위 · 통화</th><th>규격 · 검사 · 납품 조건</th><th>비교 상태 · 사유</th><th>가격 근거 · 기준일</th></tr></thead>
        <tbody>{analysis.externalQuotes.map((quote) => <tr key={quote.id}>
          <td><span className="name-cell"><span className="name">{quote.supplierName}</span><span className="code">{quote.id} · {quote.isSample ? "가상 외부 견적 기준" : "외부 완성부품 견적"}</span></span></td>
          <td className="num">{onExternalQuoteChange ? <QuotePriceInput id={quote.id} value={quote.unitPrice} onChange={onExternalQuoteChange} /> : formatPriceAmount(quote.unitPrice, quote.conditions.currency)}</td>
          <td>{known(quote.conditions.quantity)} · {known(quote.conditions.unit)} · {known(quote.conditions.currency)}</td>
          <td>{known(quote.conditions.specification)} · {known(quote.conditions.inspection)} · {known(quote.conditions.deliveryTerms)}</td>
          <td>{PRICE_STATUS_LABEL[quote.status]}{quote.reasons.length ? ` · ${quote.reasons.join(" · ")}` : ""}</td>
          <td><PriceSourceReference source={quote.source} /><p className="small muted">가격 기준일 {known(quote.conditions.priceDate)}</p>
            <details className="evidence"><summary>{quote.id} 전체 견적 조건</summary><ul>{PRICE_CONDITION_LABELS.map(([field, label]) => <li key={field}>{label}: {known(quote.conditions[field])}</li>)}</ul></details>
          </td>
        </tr>)}</tbody>
      </table></ScrollX>
    </details>
  </>;
}

export function PriceComparisonInfo({ analysis, onExternalQuoteChange, section = "all" }: { analysis: PriceAnalysis; onExternalQuoteChange?: ExternalQuoteChange; section?: "all" | "benchmark" | "conditions" | "documents" | "api" }) {
  return <div className="findings" data-price-analysis={analysis.id} data-price-revision={analysis.revision}>
    {(section === "all" || section === "benchmark") && <section><h4>시장 참고가격과 외부 견적</h4><PriceBenchmarkInfo analysis={analysis} onExternalQuoteChange={onExternalQuoteChange} /></section>}
    {(section === "all" || section === "conditions") && <section><details className="evidence"><summary>비교 조건 일치 여부 · 누락 항목 확인</summary><PriceConditionsInfo analysis={analysis} /></details></section>}
    {(section === "all" || section === "documents") && <section><details className="evidence"><summary>가격 차이를 설명하는 문서 근거</summary><PriceAnalysisDocuments analysis={analysis} /></details></section>}
    {(section === "all" || section === "api") && <section><details className="evidence"><summary>외부 API 참고 정보 · 연결 상태와 출처</summary><PriceIndicators indicators={analysis.indicators} /></details></section>}
  </div>;
}
