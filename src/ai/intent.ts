// AI 계층 ①: 규칙 기반 질문 해석 (LLM이 없어도 주요 시연 질문이 동작하도록)
import type { Grade, Item, Supplier } from "../data/types";
import type { IntentKind, PriorityMode } from "../lib/analysisTypes";

export type ParsedKind = IntentKind | "priority_followup" | "help" | "unknown";

export interface ParsedIntent {
  kind: ParsedKind;
  itemCode?: string;
  supplierIds: string[];
  grade?: Grade;
  priority?: PriorityMode;
  periodMonths?: number | null;
  threshold?: number | null;
  refersToSelection: boolean;
  unknownItemRef?: string; // 데이터에 없는 품목코드를 언급한 경우
}

export interface Catalog {
  items: Pick<Item, "itemCode" | "name">[];
  suppliers: Pick<Supplier, "supplierId" | "name">[];
}

const lc = (s: string) => s.toLowerCase();
const compact = (s: string) => lc(s).replace(/\s+/g, "");

const GENERIC_TOKENS = new Set(["세트", "부품", "조립", "자재", "품목"]);

function itemAliases(items: Catalog["items"]) {
  const tokenOwners = new Map<string, Set<string>>();
  for (const it of items) {
    for (const tok of it.name.split(/\s+/)) {
      if (tok.length < 2 || GENERIC_TOKENS.has(tok)) continue;
      const k = compact(tok);
      if (!tokenOwners.has(k)) tokenOwners.set(k, new Set());
      tokenOwners.get(k)!.add(it.itemCode);
    }
  }
  const aliases: { alias: string; code: string }[] = [];
  for (const it of items) {
    aliases.push({ alias: compact(it.name), code: it.itemCode });
    aliases.push({ alias: compact(it.itemCode), code: it.itemCode });
    for (const tok of it.name.split(/\s+/)) {
      const k = compact(tok);
      if (k.length >= 2 && tokenOwners.get(k)?.size === 1) aliases.push({ alias: k, code: it.itemCode });
    }
  }
  return aliases.sort((a, b) => b.alias.length - a.alias.length);
}

/** 가장 긴 별칭부터 찾으므로 "노즐링"은 "노즐"보다 먼저 잡힌다 */
export function findItem(text: string, items: Catalog["items"]): string | undefined {
  const t = compact(text);
  return itemAliases(items).find(({ alias }) => t.includes(alias))?.code;
}

export function findSuppliers(text: string, suppliers: Catalog["suppliers"]): string[] {
  // "A등급" 같은 등급 표현이 "업체 A"로 잘못 잡히지 않게 먼저 지운다
  const t = compact(text.replace(/[abcdABCD]\s*등급/g, " "));
  const found: { id: string; pos: number }[] = [];
  for (const s of suppliers) {
    const names = [compact(s.name), compact(s.supplierId)];
    const m = s.name.match(/^업체\s*([A-Za-z])$/);
    if (m) names.push(`${lc(m[1])}업체`, `${lc(m[1])}사`);
    for (const n of names) {
      const re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![a-z0-9])");
      const hit = re.exec(t);
      if (hit) {
        found.push({ id: s.supplierId, pos: hit.index });
        break;
      }
    }
  }
  return found.sort((a, b) => a.pos - b.pos).map((f) => f.id);
}

const PRI_WORD: Record<string, PriorityMode> = { 납기: "delivery", 단가: "price", 가격: "price", 원가: "price", 비용: "price", 품질: "quality" };

export function findPriority(text: string): PriorityMode | undefined {
  const vs = text.match(/(납기|단가|가격|원가|비용|품질)\s*보다\s*(납기|단가|가격|원가|비용|품질)/);
  if (vs) return PRI_WORD[vs[2]];
  const m = text.match(/(납기|단가|가격|원가|비용|품질)\s*(?:을|를|이|가|에)?\s*(?:더\s*)?(?:우선|중시|중요|먼저|최우선|중심|위주)/);
  if (m) return PRI_WORD[m[1]];
  if (/(균형|골고루|기본\s*가중치)/.test(text)) return "balanced";
  return undefined;
}

export function findPeriod(text: string, asOf: string): number | null {
  const m = text.match(/최근\s*(\d+)\s*(개월|달)/) || text.match(/(\d+)\s*(개월|달)\s*(간|동안)/);
  if (m) return Number(m[1]);
  const y = text.match(/최근\s*(\d+)\s*년/) || text.match(/(\d+)\s*년\s*(간|동안)/);
  if (y) return Number(y[1]) * 12;
  if (/올해|금년/.test(text)) return Number(asOf.slice(5, 7));
  return null;
}

export function parseQuestion(text: string, catalog: Catalog, asOf: string): ParsedIntent {
  const itemCode = findItem(text, catalog.items);
  const codeMention = text.match(/ITM-\d{3,}/i)?.[0];
  const supplierIds = findSuppliers(text, catalog.suppliers);
  const gradeM = text.match(/([ABCDabcd])\s*등급/);
  const grade = gradeM ? (gradeM[1].toUpperCase() as Grade) : undefined;
  const priority = findPriority(text);
  const periodMonths = findPeriod(text, asOf);
  const pctM = text.match(/(\d+(?:\.\d+)?)\s*%/);
  const threshold = pctM ? Number(pctM[1]) : null;
  const refersToSelection = /(해당|이|그|선택(한|된)|현재|지금)\s*(품목|자재|부품)/.test(text) || /품목별/.test(text);
  const refersSupplier = /(해당|이|그|선택(한|된)|현재)\s*(협력사|업체|공급사)/.test(text);

  const has = (re: RegExp) => re.test(text);
  const priceWord = has(/(단가|가격|원가)/);
  const upWord = has(/(상승|올랐|오른|오르|인상|급등|증가|뛴|올라)/);
  const deliveryWord = has(/납기/);
  const lowWord = has(/(낮|저조|미흡|부진|나쁜|나쁘|떨어|미달|미만|이하|아래|안\s*좋|지연이?\s*(많|잦|반복))/);
  const stockWord = has(/(재고|안전재고|결품|품절|부족|입고\s*예정|공급\s*지연|수급)/);
  const candWord = has(/(업체|협력사|공급사|후보|거래|공급|비교|추천|어디|누가)/);
  const profileWord = has(/(평가|점수|등급|근거|실적|어때|현황|정보|프로필|요약|정리|분석)/);

  let kind: ParsedKind = "unknown";
  if (priceWord && upWord) kind = "price_increase";
  else if (deliveryWord && lowWord) kind = "low_delivery";
  else if (stockWord) kind = "stock_risk";
  else if (grade && has(/(품질|실적|정리|현황|목록|어디|업체|협력사|보여)/)) kind = "grade_quality";
  else if (supplierIds.length >= 2) kind = "supplier_compare";
  else if ((itemCode || refersToSelection || codeMention) && candWord) kind = "item_candidates";
  else if (priority) kind = "priority_followup";
  else if ((supplierIds.length === 1 || refersSupplier) && profileWord) kind = "supplier_profile";
  else if (supplierIds.length === 1) kind = "supplier_profile";
  else if (itemCode || codeMention) kind = "item_candidates";
  else if (has(/(도움|도와|뭘|무엇을|뭐\s*할|할\s*수\s*있|사용법|기능|어떻게\s*써)/)) kind = "help";

  return {
    kind,
    itemCode,
    supplierIds,
    grade,
    priority,
    periodMonths,
    threshold,
    refersToSelection: refersToSelection || refersSupplier,
    unknownItemRef: codeMention && !itemCode ? codeMention.toUpperCase() : undefined,
  };
}
