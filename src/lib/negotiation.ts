// 단가 인상 협상: 요구 인상률 vs 주요 소재 시세 인상률을 코드로 계산한다.
// purchase-rag/backend/negotiation.py의 analyze()와 같은 규칙이다(보고서 문장은 서버 LLM이, 숫자는 코드가).
import type { DataSet } from "../data/types";
import type { Derived } from "./metrics";
import { buildMaterialSeries } from "./market";

/** 과도 판정 기준 기본값(%p) — 시연용 예시. 화면에서 담당자가 바꿀 수 있다 */
export const DEFAULT_THRESHOLD_PP = 2;

export interface NegotiationFacts {
  supplier: string;
  item: string;
  currency: string;
  unit: string;
  source: "quote" | "contract";
  prev_price: number;
  requested_price: number;
  period: string;
  materials: { name: string; change_pct: number | null }[];
  threshold_pp: number;
  sample: boolean;
}

export type Verdict = "excessive" | "within" | "insufficient_data";
export interface NegotiationResult {
  requested_change_pct: number;
  material_change_pct: number | null;
  gap_pp: number | null;
  verdict: Verdict;
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  excessive: "과도한 인상 요구 가능성",
  within: "원자재 인상률 범위 안",
  insufficient_data: "원자재 자료 부족으로 판정 보류",
};

const r1 = (v: number) => Math.round(v * 10) / 10;

export function analyze(f: Pick<NegotiationFacts, "prev_price" | "requested_price" | "materials" | "threshold_pp">): NegotiationResult {
  const requested = r1((f.requested_price / f.prev_price - 1) * 100);
  const known = f.materials.map((m) => m.change_pct).filter((v): v is number => v !== null);
  const material = known.length ? r1(known.reduce((a, b) => a + b, 0) / known.length) : null;
  const gap = material === null ? null : r1(requested - material);
  return { requested_change_pct: requested, material_change_pct: material, gap_pp: gap, verdict: gap === null ? "insufficient_data" : gap > f.threshold_pp ? "excessive" : "within" };
}

/** 협력사·품목의 계약(직전 → 최근 단가)을 기본으로, 견적서 값이 있으면 그 값으로 사실을 만든다. 계약·단가가 없으면 null */
export function buildFacts(
  data: DataSet,
  derived: Derived,
  isSample: boolean,
  supplierId: string,
  itemCode: string,
  quote: { prevPrice?: number | null; requestedPrice?: number | null; pct?: number | null } = {},
  thresholdPp = DEFAULT_THRESHOLD_PP,
): NegotiationFacts | null {
  const item = derived.itemsByCode.get(itemCode);
  const supplier = derived.suppliersById.get(supplierId);
  const contract = derived.contractViews.find((c) => c.supplierId === supplierId && c.itemCode === itemCode);
  if (!item || !supplier) return null;
  const prev = quote.prevPrice ?? contract?.unitPrice ?? null; // 견적서의 '기존 단가' = 현재 계약 단가
  const fromQuote = quote.requestedPrice != null || quote.pct != null;
  const requested = quote.requestedPrice ?? (quote.pct != null && prev ? Math.round(prev * (1 + quote.pct / 100)) : null);
  // 견적서가 없으면 계약 데이터의 직전 → 최근 단가 변동을 공급사 요구 인상으로 본다
  const [p0, p1] = fromQuote ? [prev, requested] : [contract?.prevUnitPrice ?? null, contract?.unitPrice ?? null];
  if (!p0 || !p1 || p0 <= 0 || p1 <= 0) return null;
  const series = buildMaterialSeries(data.materialPrices, data.fxRates);
  const latest = series.map((s) => s.months.at(-1)).filter(Boolean).sort().at(-1);
  const months = series.find((s) => s.months.at(-1) === latest)?.months ?? [];
  return {
    supplier: supplier.name,
    item: item.name,
    currency: contract?.currency ?? "KRW",
    unit: item.unit || "단위 미등록",
    source: fromQuote ? "quote" : "contract",
    prev_price: Math.round(p0 * 100) / 100,
    requested_price: Math.round(p1 * 100) / 100,
    period: latest && months.length >= 13 ? `${months.at(-13)} → ${latest} (국내 시세, 전년 같은 달 대비)` : "원자재 시세 기간 부족",
    materials: (item.materials ?? []).slice(0, 6).map((name) => ({ name, change_pct: series.find((s) => s.material === name)?.yoy.domestic ?? null })),
    threshold_pp: thresholdPp,
    sample: isSample,
  };
}
