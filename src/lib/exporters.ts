// 내보내기: 분석 결과·데이터 표 → 엑셀 시트
import type { AnalysisResult, ColumnKind as ResultKind } from "./analysisTypes";
import type { ColumnKind, XColumn, XSheet, XValue } from "./xlsx";
import { PRICE_CONDITION_LABELS, PRICE_STATUS_LABEL, type ExternalFinishedQuote, type PriceAnalysis, type PriceConditionKey, type SupplierPriceRecord } from "./priceComparison";

const KIND: Record<ResultKind, ColumnKind> = {
  text: "text",
  int: "int",
  number: "dec",
  percent: "pct",
  signedPercent: "pct",
  money: "int",
  grade: "text",
  date: "date",
  status: "text",
};

const PRICE_CONDITIONS = Object.entries(PRICE_CONDITION_LABELS) as [PriceConditionKey, string][];
const API_STATUS = { connected: "실제 API 조회", unavailable: "API 조회 실패", not_configured: "API 미연결", example: "API 예시 데이터", loading: "API 조회 중" };

function priceContextRows(analysis: PriceAnalysis): XValue[][] {
  return [
    ["가격 분석 식별자", analysis.id], ["가격 분석 버전", analysis.revision],
    ["가격 분석 데이터 ID", analysis.dataId], ["가격 분석 데이터 버전", analysis.dataVersion],
    ["가격 분석 기준일", analysis.asOf], ["가격 분석 데이터 구분", analysis.dataLabel],
    ["시장 참고가격 산정", "비교 조건을 충족한 외부 완성부품 견적 단가의 중앙값"],
    ["시장 참고가격", analysis.benchmark.median], ["유효 외부 견적 수", analysis.benchmark.count],
    ["유효 외부 견적 최저가", analysis.benchmark.min], ["유효 외부 견적 최고가", analysis.benchmark.max],
    ["시장 참고가격 판정", PRICE_STATUS_LABEL[analysis.benchmark.status]],
    ["시장 참고가격 확인 사유", analysis.benchmark.reasons.join(" / ")],
    ["중앙값 산정에 사용한 견적 ID", analysis.benchmark.usedQuoteIds.join(", ")],
    ["차액 산식", "협력사 단가 − 시장 참고가격"], ["차이율 산식", "차액 ÷ 시장 참고가격 × 100"],
    ...PRICE_CONDITIONS.map(([key, label]) => [`가격 비교 조건 · ${label}`, analysis.conditions[key] ?? "미확인"] as XValue[]),
    ["가격 비교 해석", "누락 조건은 일치로 보지 않으며, 비교 제외·확인 필요 대상의 차액과 차이율은 계산하지 않습니다."],
    ["평가점수 적용 범위", "기존 평가점수·등급을 가격 보정계수나 높은 단가의 정당성을 입증하는 근거로 사용하지 않습니다."],
    ["외부 API 적용 범위", "원자재·환율·가격지수는 참고 정보이며 완성부품 시장 참고가격이나 가격 보정값으로 대체하지 않습니다."],
  ];
}

function priceEvidenceSheets(analysis: PriceAnalysis): XSheet[] {
  const recordValues = (record: SupplierPriceRecord | ExternalFinishedQuote | null): XValue[] => [
    record?.source.documentId ?? "", record?.source.title ?? "가격 근거 확인 필요", record?.source.date ?? "", record?.source.page ?? "", record?.source.url ?? "",
    ...PRICE_CONDITIONS.map(([key]) => record?.conditions[key] ?? null),
  ];
  const quoteRows: XValue[][] = [
    ...analysis.rows.map((row) => [
      row.record?.kind === "contract" ? "기존 계약" : "협력사 견적", row.recordId ?? "", row.supplierName, row.supplierId, row.itemCode,
      row.supplierPrice, row.record ? (row.record.isSample ? "SAMPLE · 가상 견적" : "등록 가격 기록") : "가격 기록 없음",
      row.statusLabel, row.status, row.reasons.join(" / "), "해당 없음",
      ...recordValues(row.record), row.checks.map((check) => `${check.label}: ${PRICE_STATUS_LABEL[check.status]} · ${check.reason}`).join(" / "),
    ]),
    ...analysis.externalQuotes.map((quote) => [
      "외부 완성부품 견적", quote.id, quote.supplierName, "", quote.itemCode, quote.unitPrice,
      quote.isSample ? "SAMPLE · 가상 외부 견적" : "외부 완성부품 견적", quote.statusLabel, quote.status, quote.reasons.join(" / "),
      analysis.benchmark.usedQuoteIds.includes(quote.id) ? "사용" : "미사용", ...recordValues(quote),
      quote.checks.map((check) => `${check.label}: ${PRICE_STATUS_LABEL[check.status]} · ${check.reason}`).join(" / "),
    ]),
  ];
  const documentRows: XValue[][] = analysis.evidence.map((document) => [
    document.id, document.title, document.date, document.page ?? "", document.itemCode, document.supplierIds.join(", "), document.recordIds.join(", "),
    document.isSample ? "SAMPLE · 가상 문서" : "등록 문서", document.text,
    PRICE_CONDITIONS.map(([key, label]) => `${label}: ${document.conditions?.[key] ?? "미확인"}`).join(" / "),
  ]);
  for (const row of analysis.rows.filter((item) => !item.evidence.length)) {
    documentRows.push(["", "관련 근거를 찾지 못함", "", "", row.itemCode, row.supplierId, row.recordId ?? "", "근거 없음", "관련 근거를 찾지 못함", ""]);
  }
  if (!documentRows.length) documentRows.push(["", "관련 근거를 찾지 못함", "", "", analysis.item.itemCode, "", "", "근거 없음", "관련 근거를 찾지 못함", ""]);
  return [
    {
      name: "가격 견적·판정",
      columns: [
        ...["종류", "견적·계약 ID", "협력사", "협력사 ID", "품목"].map((header) => ({ header })),
        { header: "단가", kind: "dec" },
        ...["데이터 구분", "비교 상태", "판정 코드", "제외·확인 사유", "중앙값 산정 사용", "문서 식별자", "문서명", "문서일자", "페이지", "출처 링크", ...PRICE_CONDITIONS.map(([, label]) => `견적 조건 · ${label}`), "조건별 판정"].map((header) => ({ header })),
      ], rows: quoteRows,
    },
    {
      name: "가격 문서 근거", columns: ["문서 식별자", "문서명", "문서일자", "페이지", "품목", "적용 협력사 ID", "연결 견적·계약 ID", "데이터 구분", "문서에 기록된 내용", "문서 적용 조건"].map((header) => ({ header })), rows: documentRows,
    },
    {
      name: "외부 API 참고",
      columns: ["지표 ID", "종류", "참고 지표", "조회 상태", "상태 코드", "조회값", "단위", "통화", "출처", "출처 링크", "관측 기준일", "조회 시각", "데이터 구분", "안내"].map((header) => ({ header, ...(header === "조회값" ? { kind: "dec" as const } : {}) })),
      rows: analysis.indicators.length ? analysis.indicators.map((indicator) => [
        indicator.id, indicator.kind, indicator.label, API_STATUS[indicator.status], indicator.status,
        indicator.status === "connected" || indicator.status === "example" ? indicator.value : null,
        indicator.unit, indicator.currency, indicator.source, indicator.sourceUrl, indicator.observedAt, indicator.fetchedAt,
        indicator.isSample ? "SAMPLE · 예시 지표" : "실제 연결 상태 기준", indicator.message,
      ]) : [["", "", "", "API 미연결", "not_configured", null, "", "", "", "", "", "", "", "외부 참고 지표가 등록되지 않았습니다."]],
    },
  ];
}

/** 시트 1: 결과 표, 시트 2: 조건·근거 */
export function resultSheets(result: AnalysisResult, name: string): XSheet[] {
  const hasRank = result.rows.some((r) => r.rank);
  const foreign = result.rows.some((r) => r.currency && r.currency !== "KRW");
  const columns: XColumn[] = [
    ...(hasRank ? [{ header: result.rankLabel ?? "순서", kind: "int" as const }] : []),
    { header: "대상" },
    { header: "코드" },
    ...result.columns.map((c) => ({ header: c.unit && !c.label.includes(c.unit) ? `${c.label}(${c.unit})` : c.label, kind: c.kind === "money" && foreign ? ("dec" as const) : KIND[c.kind] })),
    { header: "통화" },
    { header: "강점" },
    { header: "위험 요소" },
    { header: result.priceAnalysis ? "비교 제외·확인 필요 사유" : "순위 제외 사유" },
  ];
  const rows: XValue[][] = result.rows.map((r) => [
    ...(hasRank ? [r.rank ?? null] : []),
    r.label,
    r.sub ?? "",
    ...result.columns.map((c) => r.values[c.key] ?? null),
    r.currency ?? "",
    r.strengths.join(" / "),
    r.risks.join(" / "),
    r.excludedReason ?? "",
  ]);
  const info: XValue[][] = [
    ["결과 이름", name],
    ["분석 유형", result.kindLabel],
    ["질문", result.question],
    ["분석 목적", result.purpose],
    ...result.scope.map((s) => [`조건 · ${s.label}`, s.value] as XValue[]),
    ["데이터 기준일", result.asOf],
    ["데이터", result.dataLabel],
    ...result.sources.filter((s) => s.ids.length).map((s) => [`사용 데이터 · ${s.label}`, `${s.ids.length}건`] as XValue[]),
    ...result.basis.map((b, i) => [`평가 근거 ${i + 1}`, b] as XValue[]),
    ...result.notes.map((n, i) => [`참고 ${i + 1}`, n] as XValue[]),
    ["만든 시각", result.createdAt.replace("T", " ").slice(0, 16)],
    ["표기", result.dataLabel.includes("SAMPLE") ? "SAMPLE · 시연용 가상 데이터가 포함되어 있습니다" : "업로드 데이터 기준"],
    ["주의", "최종 선정과 조치는 자동 확정되지 않습니다. 담당자 검토를 돕는 의사결정 지원 자료입니다."],
    ...(result.priceAnalysis ? priceContextRows(result.priceAnalysis) : []),
  ];
  return [
    { name: "결과 표", columns, rows },
    { name: "조건·근거", columns: [{ header: "항목", width: 22 }, { header: "내용", width: 90 }], rows: info },
    ...(result.priceAnalysis ? priceEvidenceSheets(result.priceAnalysis) : []),
  ];
}

export interface ExportCol<T> {
  header: string;
  kind?: ColumnKind;
  value: (r: T) => XValue;
}

export function tableSheet<T>(name: string, cols: ExportCol<T>[], rows: T[]): XSheet {
  return { name, columns: cols.map((c) => ({ header: c.header, kind: c.kind })), rows: rows.map((r) => cols.map((c) => c.value(r))) };
}

export function infoSheet(pairs: [string, XValue][]): XSheet {
  return { name: "조건·출처", columns: [{ header: "항목", width: 22 }, { header: "내용", width: 80 }], rows: pairs.map(([a, b]) => [a, b]) };
}
