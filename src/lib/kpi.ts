// 첫 화면 요약 지표 + 빠른 필터 조건 — 지표와 필터가 같은 정의를 쓰도록 한 곳에서 관리한다
import type { TabKey } from "../data/types";
import type { ContractView, Derived, InventoryView, POView, SupplierView } from "./metrics";
import { EVAL_CONFIG } from "./evaluation";

/** 빠른 필터 조건 (데이터 탭과 요약 지표가 함께 쓴다) */
export const QUICK = {
  gradeCD: (s: SupplierView) => s.evalGrade === "C" || s.evalGrade === "D",
  lowDelivery: (s: SupplierView) => s.onTimeRate !== null && s.onTimeRate < EVAL_CONFIG.lowDeliveryThreshold,
  overdue: (p: POView) => p.status === "납기 지연",
  priceUp: (c: ContractView) => (c.changeRate ?? 0) >= EVAL_CONFIG.priceIncreaseThreshold,
  belowSafety: (v: InventoryView) => v.stockQty < v.safetyStock,
};

const gradeRange = () => {
  const c = EVAL_CONFIG.gradeCutoffs;
  const b = c.find((x) => x.grade === "B")!.min;
  const cc = c.find((x) => x.grade === "C")!.min;
  return `C등급 ${cc}~${b - 1}점, D등급 ${cc}점 미만`;
};

export interface KpiDef {
  id: string;
  label: string;
  tab: TabKey;
  filterKey: string; // 데이터 탭 빠른 필터 키
  unit: string;
  totalUnit: string;
  hint: () => string;
  crit: () => string; // 카드에 바로 보이는 짧은 기준 (마우스를 올리지 않아도 기준을 알 수 있게)
  count: (d: Derived) => number;
  total: (d: Derived) => number;
}

export const KPIS: KpiDef[] = [
  {
    id: "gradeCD",
    label: "기준 미달 협력사",
    tab: "suppliers",
    filterKey: "gradeCD",
    unit: "곳",
    totalUnit: "곳",
    hint: () => `평가등급 C·D 협력사 (${EVAL_CONFIG.name}: ${gradeRange()})`,
    crit: () => "C·D등급",
    count: (d) => d.supplierViews.filter(QUICK.gradeCD).length,
    total: (d) => d.supplierViews.length,
  },
  {
    id: "overdue",
    label: "납기 지연 발주",
    tab: "purchaseOrders",
    filterKey: "overdue",
    unit: "건",
    totalUnit: "건",
    hint: () => "납기 예정일이 지났는데 아직 입고되지 않은 발주",
    crit: () => "납기 지나 미입고",
    count: (d) => d.poViews.filter(QUICK.overdue).length,
    total: (d) => d.poViews.filter((p) => p.status !== "취소").length,
  },
  {
    id: "priceUp",
    label: "단가 상승 계약",
    tab: "contracts",
    filterKey: "up",
    unit: "건",
    totalUnit: "건",
    hint: () => `최근 단가가 직전 단가보다 ${EVAL_CONFIG.priceIncreaseThreshold}% 이상 오른 계약`,
    crit: () => `직전 대비 ${EVAL_CONFIG.priceIncreaseThreshold}%↑`,
    count: (d) => d.contractViews.filter(QUICK.priceUp).length,
    total: (d) => d.contractViews.length,
  },
  {
    id: "belowSafety",
    label: "재고 미달 품목",
    tab: "inventory",
    filterKey: "below",
    unit: "품목",
    totalUnit: "품목",
    hint: () => "현재 재고가 안전재고 기준보다 적은 품목",
    crit: () => "안전재고 미만",
    count: (d) => d.inventoryViews.filter(QUICK.belowSafety).length,
    total: (d) => d.inventoryViews.length,
  },
];
