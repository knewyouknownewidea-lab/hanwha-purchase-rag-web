// 내보내기: 분석 결과·데이터 표 → 엑셀 시트
import type { AnalysisResult, ColumnKind as ResultKind } from "./analysisTypes";
import type { ColumnKind, XColumn, XSheet, XValue } from "./xlsx";

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
    { header: "순위 제외 사유" },
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
  ];
  return [
    { name: "결과 표", columns, rows },
    { name: "조건·근거", columns: [{ header: "항목", width: 22 }, { header: "내용", width: 90 }], rows: info },
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
