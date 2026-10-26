import type { DataSet } from "../data/types";
import type { PriceAnalysis } from "../lib/priceComparison";

export interface PriceQuestion { itemCode: string | null; supplierIds?: string[]; reason?: string }
const normalize = (text: string) => text.replace(/\s+/g, "").toLowerCase();

/** 현재 선택·표의 가격을 질문에 연결한다. 구매 DB의 다른 식별자로 바꾸지 않는다. */
export function priceQuestion(question: string, data: DataSet, selection: { itemCode: string | null; supplierId: string | null }, current?: PriceAnalysis): PriceQuestion | null {
  const q = normalize(question);
  if (/(?:원자재|니켈|구리|철광석|알루미늄|인건비|임금)/.test(q) && !/완성부품|외부.*견적|업체.*단가/.test(q) && !data.items.some(item => q.includes(normalize(item.itemCode)) || q.includes(normalize(item.name)))) return null;
  const main = /시장(?:참고)?가격|외부.*(?:견적|가격)|시장.*(?:비교|단가)|단가.*(?:시장|비교)|가격차|차액|차이율|완성부품/.test(q);
  const followup = !!current && /(?:왜|어떻게|계산|근거|제외|확인필요|재검토|\d+(?:\.\d+)?%)/.test(q);
  if (!main && /평가|등급|불량|납기/.test(q)) return null;
  if (!main && !followup) return null;
  const explicitCodes = q.match(/itm-[a-z0-9_-]+/g) ?? [];
  if (explicitCodes.some(code => !data.items.some(item => normalize(item.itemCode) === code))) return { itemCode: null, reason: "질문에 적은 품목 코드를 현재 데이터에서 찾지 못했습니다. 비교할 품목을 확인해 주세요." };
  const items = data.items.filter(i => q.includes(normalize(i.itemCode)) || (i.name && q.includes(normalize(i.name))));
  if (items.length > 1) return { itemCode: null, reason: "비교할 품목을 한 개 선택해 주세요." };
  const itemCode = items[0]?.itemCode ?? selection.itemCode ?? current?.item.itemCode ?? null;
  if (!itemCode || !data.items.some(i => i.itemCode === itemCode)) return { itemCode: null, reason: "가격을 비교할 품목을 표에서 선택하거나 품목명·코드를 질문에 적어 주세요." };
  // 전체 가격 비교는 협력사 전체를 유지하고, 명시적인 '만' 요청에만 행 범위를 좁힌다.
  const suppliers = data.suppliers.filter(s => {
    const name = normalize(s.name).replace(/\((?:가상|데모|sample)\)/g, ""), tail = name.replace(/^업체/, "");
    return q.includes(normalize(s.supplierId)) || q.includes(name) || (tail !== name && q.includes(tail + "업체"));
  });
  const supplierIds = q.includes("만") && suppliers.length ? suppliers.map(s => s.supplierId)
    : followup && !main && current?.item.itemCode === itemCode && !/전체|모든|업체별/.test(q) ? current.supplierIds : undefined;
  return { itemCode, ...(supplierIds ? { supplierIds } : {}) };
}
