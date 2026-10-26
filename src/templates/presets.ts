// 템플릿 보기 설정과 프리셋
// 설정은 결과 데이터를 바꾸지 않고 "보이는 방식"만 바꾼다.
// 열·차트·지표는 분석 유형마다 키가 다르므로 "선호 목록"으로 저장하고, 결과에 있는 키만 골라 쓴다.
import type { AnalysisResult, ChartSpec, ResultColumn } from "../lib/analysisTypes";

export type ReportSection = "purpose" | "scope" | "results" | "comparison" | "risks" | "review" | "basis";

export const REPORT_SECTIONS: { id: ReportSection; label: string }[] = [
  { id: "purpose", label: "분석 목적" },
  { id: "scope", label: "조건·데이터 범위" },
  { id: "results", label: "주요 분석 결과" },
  { id: "comparison", label: "비교 결과 표" },
  { id: "risks", label: "위험 요소" },
  { id: "review", label: "검토 의견" },
  { id: "basis", label: "평가 근거·참조 데이터" },
];

export interface TableSettings {
  columns: "primary" | "all" | string[];
  density: "compact" | "comfortable";
  sort: { key: string; dir: "asc" | "desc" } | null; // __rank, __label 또는 열 키
  showBest: boolean;
  showExcluded: boolean;
}

export interface ChartSettings {
  charts: "all" | string[];
  valueLabels: boolean;
  refLine: boolean;
  perRow: 1 | 2;
}

export interface CardSettings {
  perRow: 1 | 2 | 3;
  metrics: "default" | string[];
  sort: string; // __rank, __label 또는 열 키
  expand: boolean;
  sortDir: "auto" | "asc" | "desc"; // auto = 좋은 값이 먼저
}

export interface ReportSettings {
  sections: Record<ReportSection, boolean>;
  mode: "summary" | "detailed";
}

export interface ViewSettings {
  table: TableSettings;
  chart: ChartSettings;
  cards: CardSettings;
  report: ReportSettings;
}

export interface Preset {
  id: string;
  name: string;
  description: string;
  settings: ViewSettings;
  builtIn?: boolean;
}

const allSections = (on = true): Record<ReportSection, boolean> =>
  Object.fromEntries(REPORT_SECTIONS.map((s) => [s.id, on])) as Record<ReportSection, boolean>;

export const DEFAULT_SETTINGS: ViewSettings = {
  table: { columns: "primary", density: "comfortable", sort: null, showBest: true, showExcluded: true },
  chart: { charts: "all", valueLabels: true, refLine: true, perRow: 2 },
  cards: { perRow: 2, metrics: "default", sort: "__rank", expand: false, sortDir: "auto" },
  report: { sections: allSections(true), mode: "detailed" },
};

// 구매 실무에서 결과를 보는 대표 상황 4가지
export const BUILT_IN_PRESETS: Preset[] = [
  {
    id: "select",
    name: "업체 선정 검토",
    description: "발주 전 후보 업체를 모든 항목으로 비교",
    builtIn: true,
    settings: {
      table: { columns: "all", density: "comfortable", sort: { key: "__rank", dir: "asc" }, showBest: true, showExcluded: true },
      chart: { charts: "all", valueLabels: true, refLine: true, perRow: 2 },
      cards: { perRow: 2, metrics: "default", sort: "__rank", expand: true, sortDir: "auto" },
      report: { sections: allSections(true), mode: "detailed" },
    },
  },
  {
    id: "delivery",
    name: "납기·공급 리스크 점검",
    description: "납기 지연, 미입고, 재고 부족을 먼저 확인",
    builtIn: true,
    settings: {
      table: {
        columns: ["grade", "onTimeRate", "late", "overdue", "avgDelay", "evaluated", "trades", "lastTrade", "topItem", "status", "stock", "safety", "shortage", "open", "expected", "supplier", "delivery", "score", "weight", "weighted"],
        density: "comfortable",
        sort: { key: "onTimeRate", dir: "asc" },
        showBest: false,
        showExcluded: true,
      },
      chart: { charts: ["ontime", "ontime-all", "ontime-q", "items", "q", "cover"], valueLabels: true, refLine: true, perRow: 2 },
      cards: { perRow: 2, metrics: ["onTimeRate", "late", "overdue", "avgDelay", "shortage", "open", "stock", "safety", "delivery", "score"], sort: "onTimeRate", expand: true, sortDir: "auto" },
      report: { sections: { ...allSections(true), basis: false }, mode: "detailed" },
    },
  },
  {
    id: "cost",
    name: "단가·원가 협상 준비",
    description: "단가 수준과 변동, 비교 조건 차이를 중심으로",
    builtIn: true,
    settings: {
      table: {
        columns: ["grade", "price", "priceChange", "changeRate", "prev", "peer", "condition", "currency", "endDate", "trades", "lastTrade", "cost", "total"],
        density: "comfortable",
        sort: { key: "price", dir: "asc" },
        showBest: true,
        showExcluded: true,
      },
      chart: { charts: ["price", "trend", "change", "index", "crit"], valueLabels: true, refLine: false, perRow: 2 },
      cards: { perRow: 2, metrics: ["price", "priceChange", "changeRate", "prev", "peer", "cost", "total"], sort: "price", expand: true, sortDir: "auto" },
      report: { sections: allSections(true), mode: "detailed" },
    },
  },
  {
    id: "brief",
    name: "보고용 요약",
    description: "팀장 보고용으로 핵심만 간단히",
    builtIn: true,
    settings: {
      table: { columns: "primary", density: "compact", sort: { key: "__rank", dir: "asc" }, showBest: true, showExcluded: true },
      chart: { charts: "all", valueLabels: true, refLine: true, perRow: 2 },
      cards: { perRow: 3, metrics: "default", sort: "__rank", expand: false, sortDir: "auto" },
      report: { sections: { ...allSections(true), scope: false, basis: false }, mode: "summary" },
    },
  },
];

export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** 저장된 값이 예전 형식이어도 깨지지 않게 기본값과 합친다 */
export function normalizeSettings(v: unknown): ViewSettings {
  const s = (v && typeof v === "object" ? v : {}) as Partial<ViewSettings>;
  const d = clone(DEFAULT_SETTINGS);
  return {
    table: { ...d.table, ...(s.table || {}) },
    chart: { ...d.chart, ...(s.chart || {}) },
    cards: { ...d.cards, ...(s.cards || {}) },
    report: { ...d.report, ...(s.report || {}), sections: { ...d.report.sections, ...(s.report?.sections || {}) } },
  };
}

export function resolveColumns(result: AnalysisResult, pref: TableSettings["columns"]): ResultColumn[] {
  if (pref === "all") return result.columns;
  if (pref !== "primary") {
    const picked = result.columns.filter((c) => pref.includes(c.key));
    if (picked.length) return picked;
  }
  return result.columns.filter((c) => c.primary);
}

export function resolveCharts(result: AnalysisResult, pref: ChartSettings["charts"]): ChartSpec[] {
  if (pref === "all") return result.charts;
  const picked = result.charts.filter((c) => pref.includes(c.id));
  return picked.length ? picked : result.charts;
}

export function resolveMetrics(result: AnalysisResult, pref: CardSettings["metrics"]): string[] {
  if (pref !== "default") {
    const picked = pref.filter((k) => result.columns.some((c) => c.key === k)).slice(0, 6);
    if (picked.length) return picked;
  }
  return result.cardMetrics;
}

/** 현재 설정이 어느 프리셋과 같은지 */
export function matchPreset(settings: ViewSettings, presets: Preset[]): string | null {
  const s = JSON.stringify(settings);
  if (s === JSON.stringify(DEFAULT_SETTINGS)) return "default";
  return presets.find((p) => JSON.stringify(normalizeSettings(p.settings)) === s)?.id ?? null;
}
