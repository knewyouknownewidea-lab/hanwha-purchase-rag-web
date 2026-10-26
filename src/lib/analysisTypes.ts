// 분석 결과 공통 구조 — 템플릿(표·차트·카드·보고서)은 모두 이 구조만 읽는다
import type { DatasetKey, Grade } from "../data/types";

export type TemplateId = "table" | "chart" | "cards" | "report";

export type IntentKind =
  | "item_candidates"
  | "low_delivery"
  | "price_increase"
  | "grade_quality"
  | "supplier_profile"
  | "supplier_compare"
  | "stock_risk";

export type PriorityMode = "balanced" | "delivery" | "price" | "quality";

export interface AnalysisParams {
  kind: IntentKind;
  itemCode?: string;
  supplierIds?: string[];
  grade?: Grade;
  priority?: PriorityMode;
  periodMonths?: number | null;
  threshold?: number | null;
}

export type ColumnKind = "text" | "int" | "number" | "percent" | "signedPercent" | "money" | "grade" | "date" | "status";

export interface ResultColumn {
  key: string;
  label: string;
  kind: ColumnKind;
  digits?: number;
  higherIsBetter?: boolean;
  primary?: boolean; // 좁은 화면 기본 표시 열
  unit?: string;
}

export interface ResultRow {
  id: string;
  label: string;
  sub?: string;
  supplierId?: string;
  itemCode?: string;
  currency?: string;
  values: Record<string, string | number | null>;
  strengths: string[];
  risks: string[];
  evidence: string[];
  rank?: number | null;
  excludedReason?: string;
}

export interface ChartSeries {
  key: string;
  label: string;
  values: (number | null)[];
}

export interface ChartSpec {
  id: string;
  title: string;
  type: "bar" | "hbar" | "line";
  unit: string;
  yLabel: string;
  xLabel?: string;
  categories: string[];
  series: ChartSeries[];
  refLine?: { value: number; label: string };
  xMarker?: { index: number; label: string }; // 막대 차트: 이 칸의 왼쪽 경계에 세로 점선 (예: 오늘·기준일)
  statusOf?: ("critical" | null)[]; // 단일 계열 막대의 상태 표시(기준 미달 등)
  statusLabel?: string;
  caption?: string;
  digits?: number;
}

export interface SourceRef {
  table: DatasetKey;
  label: string;
  ids: string[];
}

export interface AnalysisResult {
  id: string;
  params: AnalysisParams;
  kind: IntentKind;
  kindLabel: string;
  title: string;
  question: string;
  purpose: string;
  createdAt: string;
  dataVersion: number;
  dataId: string;
  asOf: string;
  dataLabel: string;
  scope: { label: string; value: string }[];
  columns: ResultColumn[];
  rows: ResultRow[];
  rankLabel?: string;
  cardMetrics: string[];
  highlights: { label: string; value: string; rowId?: string }[];
  summary: string[];
  risks: string[];
  reviewPoints: string[];
  basis: string[];
  notes: string[];
  sources: SourceRef[];
  charts: ChartSpec[];
  recommended: TemplateId;
  templates: TemplateId[];
  templateHints: Partial<Record<TemplateId, string>>;
  empty?: string; // 결과가 없을 때 이유
}
