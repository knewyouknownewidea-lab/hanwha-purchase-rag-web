// 분석 계층 ②: 원천 데이터에서 파생 지표를 계산한다 (납기 상태, 납기 준수율, 단가 변동, 재고 상태)
import type { Contract, DataSet, InventoryRecord, Item, PurchaseOrder, Supplier } from "../data/types";
import { addMonths, avg, daysBetween, quarterOf, quarterSortKey, round } from "./format";
import { EVAL_CONFIG, comparableKey, evaluateSupplier, type SupplierEvaluation } from "./evaluation";
import { buildBomIndex, type BomIndex } from "./bom";
import { buildPayments, type PaymentSchedule } from "./payments";

export type POStatus = "입고완료" | "지연입고" | "납기 지연" | "진행 중" | "취소";

export interface POView extends PurchaseOrder {
  status: POStatus;
  delayDays: number | null;
  evaluated: boolean;
  onTime: boolean | null;
  itemName: string;
  supplierName: string;
}

export interface DeliveryStats {
  poCount: number;
  evaluated: number;
  onTime: number;
  late: number;
  rate: number | null;
  avgDelay: number | null;
  overdueOpen: number;
  open: number;
  lastTradeDate: string | null;
}

export interface ContractView extends Contract {
  itemName: string;
  supplierName: string;
  changeRate: number | null;
  comparableKey: string;
  expiresInDays: number | null;
}

export interface InventoryView extends InventoryRecord {
  itemName: string;
  unit: string;
  supplierName: string;
  openOrderQty: number;
  expectedDate: string | null;
  overdueOpen: number;
  shortage: number;
  delayed: boolean;
  status: "정상" | "안전재고 미달" | "공급 지연" | "미달·지연";
}

export interface SupplierView extends Supplier {
  onTimeRate: number | null;
  tradeDate: string | null;
  evalGrade: string | null;
  evalScore: number | null;
  poCount: number;
}

export interface Derived {
  asOf: string;
  windowFrom: string;
  itemsByCode: Map<string, Item>;
  suppliersById: Map<string, Supplier>;
  poViews: POView[];
  supplierDelivery: Map<string, DeliveryStats>;
  pairDelivery: Map<string, DeliveryStats>;
  contractViews: ContractView[];
  inventoryViews: InventoryView[];
  evaluations: Map<string, SupplierEvaluation>;
  supplierViews: SupplierView[];
  bomIndex: BomIndex;
  payments: PaymentSchedule;
}

export const pairKey = (supplierId: string, itemCode: string) => `${supplierId}|${itemCode}`;

export function poStatus(po: PurchaseOrder, asOf: string): Pick<POView, "status" | "delayDays" | "evaluated" | "onTime"> {
  if (po.canceled) return { status: "취소", delayDays: null, evaluated: false, onTime: null };
  if (po.receivedDate) {
    const delay = daysBetween(po.dueDate, po.receivedDate);
    return delay > 0
      ? { status: "지연입고", delayDays: delay, evaluated: true, onTime: false }
      : { status: "입고완료", delayDays: 0, evaluated: true, onTime: true };
  }
  if (po.dueDate < asOf) return { status: "납기 지연", delayDays: daysBetween(po.dueDate, asOf), evaluated: true, onTime: false };
  return { status: "진행 중", delayDays: null, evaluated: false, onTime: null };
}

export function deliveryStats(pos: POView[]): DeliveryStats {
  const ev = pos.filter((p) => p.evaluated);
  const onTime = ev.filter((p) => p.onTime).length;
  const delays = ev.filter((p) => !p.onTime && p.delayDays !== null).map((p) => p.delayDays as number);
  const dates = pos.filter((p) => p.status !== "취소").map((p) => p.orderDate).sort();
  return {
    poCount: pos.filter((p) => p.status !== "취소").length,
    evaluated: ev.length,
    onTime,
    late: ev.length - onTime,
    rate: ev.length ? round((onTime / ev.length) * 100, 1) : null,
    avgDelay: delays.length ? round(avg(delays) as number, 1) : null,
    overdueOpen: pos.filter((p) => p.status === "납기 지연").length,
    open: pos.filter((p) => p.status === "진행 중").length,
    lastTradeDate: dates.length ? dates[dates.length - 1] : null,
  };
}

export function derive(data: DataSet, asOf: string): Derived {
  const itemsByCode = new Map(data.items.map((i) => [i.itemCode, i]));
  const suppliersById = new Map(data.suppliers.map((s) => [s.supplierId, s]));
  const windowFrom = addMonths(asOf, -EVAL_CONFIG.windowMonths);
  const itemName = (c: string) => itemsByCode.get(c)?.name ?? c;
  const supName = (id: string) => suppliersById.get(id)?.name ?? id;

  const poViews: POView[] = data.purchaseOrders.map((po) => ({
    ...po,
    ...poStatus(po, asOf),
    itemName: itemName(po.itemCode),
    supplierName: supName(po.supplierId),
  }));
  const inWindow = poViews.filter((p) => p.orderDate >= windowFrom);

  const bySupplier = new Map<string, POView[]>();
  const byPair = new Map<string, POView[]>();
  for (const p of inWindow) {
    if (!bySupplier.has(p.supplierId)) bySupplier.set(p.supplierId, []);
    bySupplier.get(p.supplierId)!.push(p);
    const k = pairKey(p.supplierId, p.itemCode);
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k)!.push(p);
  }
  const supplierDelivery = new Map<string, DeliveryStats>();
  for (const s of data.suppliers) supplierDelivery.set(s.supplierId, deliveryStats(bySupplier.get(s.supplierId) ?? []));
  const pairDelivery = new Map<string, DeliveryStats>();
  for (const [k, list] of byPair) pairDelivery.set(k, deliveryStats(list));

  const contractViews: ContractView[] = data.contracts.map((c) => ({
    ...c,
    itemName: itemName(c.itemCode),
    supplierName: supName(c.supplierId),
    changeRate: c.prevUnitPrice ? round((c.unitPrice / c.prevUnitPrice - 1) * 100, 1) : null,
    comparableKey: comparableKey({ ...c, spec: c.spec || itemsByCode.get(c.itemCode)?.spec }),
    expiresInDays: c.endDate ? daysBetween(asOf, c.endDate) : null,
  }));

  const inventoryViews: InventoryView[] = data.inventory.map((inv) => {
    const open = poViews.filter((p) => p.itemCode === inv.itemCode && (p.status === "진행 중" || p.status === "납기 지연"));
    const overdue = open.filter((p) => p.status === "납기 지연").length;
    const dueDates = open.map((p) => p.dueDate).sort();
    const shortage = Math.max(0, inv.safetyStock - inv.stockQty);
    const below = inv.stockQty < inv.safetyStock;
    const sid = inv.mainSupplierId || "";
    return {
      ...inv,
      itemName: itemName(inv.itemCode),
      unit: itemsByCode.get(inv.itemCode)?.unit ?? "",
      supplierName: sid ? supName(sid) : "–",
      openOrderQty: open.reduce((a, p) => a + p.qty, 0),
      expectedDate: dueDates.length ? dueDates[0] : null,
      overdueOpen: overdue,
      shortage,
      delayed: overdue > 0,
      status: below && overdue ? "미달·지연" : below ? "안전재고 미달" : overdue ? "공급 지연" : "정상",
    };
  });

  const partial: Derived = {
    asOf,
    windowFrom,
    itemsByCode,
    suppliersById,
    poViews,
    supplierDelivery,
    pairDelivery,
    contractViews,
    inventoryViews,
    evaluations: new Map(),
    supplierViews: [],
    bomIndex: buildBomIndex(data.bom ?? []),
    payments: buildPayments(poViews, data.contracts, asOf),
  };
  for (const s of data.suppliers) partial.evaluations.set(s.supplierId, evaluateSupplier(s.supplierId, partial));
  partial.supplierViews = data.suppliers.map((s) => {
    const del = supplierDelivery.get(s.supplierId)!;
    const ev = partial.evaluations.get(s.supplierId)!;
    return {
      ...s,
      onTimeRate: del.rate,
      tradeDate: s.lastTradeDate || del.lastTradeDate,
      evalGrade: ev.grade,
      evalScore: ev.total,
      poCount: del.poCount,
    };
  });
  return partial;
}

/** 분기별 평균 단가 (동일 통화만) */
export function priceByQuarter(pos: POView[]): Map<string, { label: string; value: number }> {
  const groups = new Map<string, number[]>();
  const labels = new Map<string, string>();
  for (const p of pos) {
    if (p.unitPrice === null || p.unitPrice === undefined || p.status === "취소") continue;
    const k = quarterSortKey(p.orderDate);
    labels.set(k, quarterOf(p.orderDate));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(p.unitPrice);
  }
  const out = new Map<string, { label: string; value: number }>();
  for (const [k, xs] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) out.set(k, { label: labels.get(k)!, value: avg(xs) as number });
  return out;
}

/** 분기별 납기 준수율 */
export function deliveryByQuarter(pos: POView[]): Map<string, { label: string; value: number; n: number }> {
  const groups = new Map<string, POView[]>();
  const labels = new Map<string, string>();
  for (const p of pos) {
    if (!p.evaluated) continue;
    const k = quarterSortKey(p.dueDate);
    labels.set(k, quarterOf(p.dueDate));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(p);
  }
  const out = new Map<string, { label: string; value: number; n: number }>();
  for (const [k, xs] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.set(k, { label: labels.get(k)!, value: round((xs.filter((x) => x.onTime).length / xs.length) * 100, 1), n: xs.length });
  }
  return out;
}
