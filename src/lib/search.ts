// 검색 계층: 키워드로 5종 데이터를 함께 찾는다 (AI 없이 동작)
import type { TabKey } from "../data/types";
import type { Derived } from "./metrics";
import { fmtMoney, fmtPct, fmtSignedPct } from "./format";

export interface SearchHit {
  key: string;
  tab: TabKey;
  tabLabel: string;
  source: string;
  title: string;
  subtitle: string;
  rowKey: string;
  supplierId?: string;
  itemCode?: string;
  score: number;
}

const compact = (s: string) => s.toLowerCase().replace(/\s+/g, "");

interface Doc {
  hit: Omit<SearchHit, "score">;
  text: string;
  ids: string[];
}

function buildDocs(d: Derived): Doc[] {
  const docs: Doc[] = [];
  for (const s of d.supplierViews) {
    const ev = d.evaluations.get(s.supplierId);
    docs.push({
      hit: {
        key: `sup-${s.supplierId}`,
        tab: "suppliers",
        tabLabel: "협력업체",
        source: "협력업체 · 평가",
        title: `${s.name} (${s.supplierId})`,
        subtitle: `평가 ${ev?.grade ?? "–"}등급 · 품질 ${s.qualityScore ?? "–"}점 · 납기 ${fmtPct(s.onTimeRate)} · ${s.process ?? ""}`,
        rowKey: s.supplierId,
        supplierId: s.supplierId,
      },
      text: [s.name, s.supplierId, s.process, s.region, `${ev?.grade}등급`, s.items.map((c) => d.itemsByCode.get(c)?.name ?? c).join(" "), s.items.join(" "), "품질 평가 결과"].join(" "),
      ids: [s.supplierId],
    });
  }
  for (const it of d.itemsByCode.values()) {
    const inv = d.inventoryViews.find((v) => v.itemCode === it.itemCode);
    docs.push({
      hit: {
        key: `item-${it.itemCode}`,
        tab: "inventory",
        tabLabel: "자재-공급관리",
        source: "품목 마스터 · 재고",
        title: `${it.name} (${it.itemCode})`,
        subtitle: `${it.spec ?? ""}${inv ? ` · 재고 ${inv.stockQty}/${inv.safetyStock} · ${inv.status}` : ""}`,
        rowKey: it.itemCode,
        itemCode: it.itemCode,
      },
      text: [it.name, it.itemCode, it.spec, it.category].join(" "),
      ids: [it.itemCode],
    });
  }
  for (const p of d.poViews) {
    docs.push({
      hit: {
        key: `po-${p.poNo}`,
        tab: "purchaseOrders",
        tabLabel: "구매조달",
        source: "구매조달 · 발주/납기 이력",
        title: `${p.poNo} · ${p.itemName}`,
        subtitle: `${p.supplierName} · 납기 ${p.dueDate} · ${p.status}${p.delayDays ? ` (${p.delayDays}일)` : ""}`,
        rowKey: p.poNo,
        supplierId: p.supplierId,
        itemCode: p.itemCode,
      },
      text: [p.poNo, p.itemName, p.itemCode, p.supplierName, p.supplierId, p.status, p.status === "지연입고" || p.status === "납기 지연" ? "납기 지연 이력" : "납기 이력"].join(" "),
      ids: [p.poNo],
    });
  }
  for (const c of d.contractViews) {
    docs.push({
      hit: {
        key: `ct-${c.contractId}`,
        tab: "contracts",
        tabLabel: "원가-계약",
        source: "원가-계약",
        title: `${c.contractId} · ${c.itemName}`,
        subtitle: `${c.supplierName} · ${fmtMoney(c.unitPrice, c.currency)} (${fmtSignedPct(c.changeRate)}) · ${c.endDate ?? ""} 종료`,
        rowKey: c.contractId,
        supplierId: c.supplierId,
        itemCode: c.itemCode,
      },
      text: [c.contractId, c.itemName, c.itemCode, c.supplierName, c.supplierId, c.deliveryTerms, c.paymentTerms, c.currency, "계약 단가"].join(" "),
      ids: [c.contractId],
    });
  }
  return docs;
}

let cache: { d: Derived; docs: Doc[] } | null = null;

export function search(query: string, d: Derived, limit = 40): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  if (!cache || cache.d !== d) cache = { d, docs: buildDocs(d) };
  const tokens = q.split(/\s+/).map(compact).filter(Boolean);
  const hits: SearchHit[] = [];
  for (const doc of cache.docs) {
    const text = compact(doc.text);
    if (!tokens.every((t) => text.includes(t))) continue;
    let score = 1;
    const cq = compact(q);
    if (doc.ids.some((id) => compact(id) === cq)) score += 10;
    if (compact(doc.hit.title).startsWith(cq)) score += 4;
    if (compact(doc.hit.title).includes(cq)) score += 2;
    if (doc.hit.tab === "suppliers" || doc.hit.key.startsWith("item-")) score += 1;
    hits.push({ ...doc.hit, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
