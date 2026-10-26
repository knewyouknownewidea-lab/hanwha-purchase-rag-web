// 템플릿 목록 — 새 템플릿은 여기에 등록하고 ResultPanel의 RENDERERS에 렌더러를 추가하면 된다
import type { IconType } from "react-icons";
import { LuChartColumn, LuFileText, LuLayoutGrid, LuTable2 } from "react-icons/lu";
import type { IntentKind, TemplateId } from "../lib/analysisTypes";

export interface TemplateDef {
  id: TemplateId;
  label: string;
  short: string;
  description: string;
  icon: IconType;
}

export const TEMPLATE_ORDER: TemplateId[] = ["table", "chart", "cards", "report"];

export const TEMPLATES: Record<TemplateId, TemplateDef> = {
  table: { id: "table", label: "협력사 비교표", short: "비교표", description: "항목을 나란히 놓고 정렬해 비교", icon: LuTable2 },
  chart: { id: "chart", label: "데이터 시각화", short: "차트", description: "막대·선 그래프로 차이와 추이 확인", icon: LuChartColumn },
  cards: { id: "cards", label: "종합 평가 카드", short: "카드", description: "대상별 점수·강점·위험 요소", icon: LuLayoutGrid },
  report: { id: "report", label: "분석 보고서", short: "보고서", description: "목적·결과·검토 의견·근거를 문서로", icon: LuFileText },
};

// 분석 유형별로 템플릿이 실제로 보여 주는 내용 (템플릿 버튼 아래 작은 설명)
const CONTENT: Partial<Record<IntentKind, Partial<Record<TemplateId, string>>>> = {
  item_candidates: { table: "후보 업체별 등급·납기·단가", chart: "납기 준수율·단가 비교", cards: "업체별 장단점과 검토 순서", report: "근거·검토 의견 포함" },
  supplier_profile: { table: "평가 항목별 점수", chart: "항목 점수·납기 추이", cards: "항목별 계산 근거", report: "평가 근거 리포트" },
  stock_risk: { table: "위험 품목별 재고·입고 예정", chart: "안전재고 충족률", cards: "품목별 위험 요소", report: "조달 조치 검토" },
  price_increase: { table: "계약별 단가 변동", chart: "변동률·단가 추이", cards: "계약별 위험 요소", report: "협상 검토 의견" },
  low_delivery: { table: "지연 건수·평균 지연일", chart: "협력사별 납기 준수율", cards: "업체별 위험 요소", report: "관리 우선순위" },
  grade_quality: { table: "품질·납기·종합 점수", chart: "품질 점수·불량률", cards: "업체별 강점·위험", report: "품질 실적 요약" },
  supplier_compare: { table: "항목별 점수 비교", chart: "항목별 점수 막대", cards: "업체별 강점·약점", report: "비교 보고서" },
};

export const templateLabel = (id: TemplateId) => TEMPLATES[id].label;
export const templateContent = (id: TemplateId, kind?: IntentKind) => (kind && CONTENT[kind]?.[id]) || TEMPLATES[id].description;
