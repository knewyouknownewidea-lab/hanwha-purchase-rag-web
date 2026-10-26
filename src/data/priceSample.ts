// 기존 계약·발주·평가 이력은 수정하지 않습니다. 아래는 새로 받은 것으로 가정한 별도 가상 견적입니다.
import type { DataMeta, DataSet } from "./types";
import type { MarketIndicator, PriceConditions, PriceEvidence, PriceInputs } from "../lib/priceComparison";

export const PRICE_SAMPLE_CONDITIONS: PriceConditions = {
  itemCode: "ITM-1001", drawing: "CL-500-R1", specification: "Ø500 × 2,100mm, 특수주철",
  material: "특수주철", processing: "완성가공·호닝", inspection: "전수 치수검사·진원도 0.02mm 이하",
  quantity: 10, unit: "EA", currency: "KRW", priceDate: "2026-10-15",
  taxTerms: "부가세 별도", transportTerms: "운송비 포함", deliveryTerms: "창원 공장 도착도",
};
export const PRICE_SAMPLE_EVIDENCE: PriceEvidence[] = [
  ...["A", "B", "C", "D"].map((letter, i) => ({
    id: `PRICE-INT-${letter}`, itemCode: "ITM-1001", supplierIds: [`SUP-00${i + 1}`], recordIds: [`INT-LINER-${letter}`],
    title: `가상 신규 협력사 견적 ${letter} 조건서`, date: "2026-10-15", page: "1", isSample: true,
    conditions: { ...PRICE_SAMPLE_CONDITIONS, ...(letter === "D" ? { inspection: "전수 치수검사만(진원도 검사 미포함)" } : {}) },
    text: `SAMPLE · 실제 자료 아님. 실린더 라이너 ITM-1001, 도면 CL-500-R1, Ø500 × 2,100mm 특수주철, 완성가공·호닝, 수량 10 EA, KRW, 부가세 별도, 운송비 포함, 창원 공장 도착도. 검사: ${letter === "D" ? "전수 치수검사만(진원도 검사 미포함)" : "전수 치수검사·진원도 0.02mm 이하"}. 기존 계약과 다른 신규 가상 견적이다. 금액은 연결된 현재 가상 견적 레코드에서 확인하며, 가격 차이의 원가 사유는 이 문서에 기재되어 있지 않다.`,
  })),
  ...[1, 2, 3].map((n) => ({
    id: `PRICE-EXT-00${n}`, itemCode: "ITM-1001", supplierIds: [], recordIds: [`EXT-LINER-00${n}`],
    title: `가상 외부 완성부품 견적 ${n} 조건서`, date: "2026-10-15", page: "1", isSample: true,
    conditions: { ...PRICE_SAMPLE_CONDITIONS },
    text: "SAMPLE · 실제 자료 아님. 외부 완성부품 실린더 라이너 ITM-1001, 도면 CL-500-R1, Ø500 × 2,100mm 특수주철, 완성가공·호닝, 전수 치수검사·진원도 0.02mm 이하, 수량 10 EA, KRW, 부가세 별도, 운송비 포함, 창원 공장 도착도. 금액은 편집 가능한 연결 가상 견적 레코드에서 확인한다. 실제 기관·거래소 자료가 아니다.",
  })),
];
export const PRICE_SAMPLE_INDICATORS: MarketIndicator[] = [
  { id: "fx-usd-krw", kind: "fx", label: "USD/KRW 환율", status: "not_configured", value: null, unit: "KRW/USD", currency: "KRW", source: "외부 환율 API", sourceUrl: null, observedAt: null, fetchedAt: null, message: "외부 API 연결 상태를 확인하지 않았습니다. 완성부품 참고가격 계산에는 사용하지 않습니다.", isSample: false },
  { id: "raw-material", kind: "material", label: "원자재 가격", status: "not_configured", value: null, unit: "", currency: null, source: "미연결", sourceUrl: null, observedAt: null, fetchedAt: null, message: "실제 원자재 가격 API가 연결되지 않았습니다.", isSample: false },
  { id: "price-index", kind: "index", label: "관련 가격지수", status: "not_configured", value: null, unit: "지수", currency: null, source: "미연결", sourceUrl: null, observedAt: null, fetchedAt: null, message: "실제 가격지수 API가 연결되지 않았습니다.", isSample: false },
];

export function createPriceSample(data: DataSet, meta: DataMeta): PriceInputs {
  const isOriginalSample = meta.isSample && meta.dataId === "sample";
  const item = data.items.find((row) => row.itemCode === "ITM-1001") ?? data.items[0];
  const inputs: PriceInputs = {
    revision: isOriginalSample ? "price-sample-v1" : `price-${meta.version}`, dataId: meta.dataId, asOf: meta.asOf,
    conditions: isOriginalSample ? structuredClone(PRICE_SAMPLE_CONDITIONS) : { itemCode: item?.itemCode ?? null, specification: item?.spec ?? null, unit: item?.unit ?? null, priceDate: meta.asOf },
    supplierQuotes: [], externalQuotes: [], contractConditions: {}, evidence: [], indicators: structuredClone(PRICE_SAMPLE_INDICATORS),
  };
  if (!isOriginalSample) return inputs;
  inputs.supplierQuotes = [1120000, 1050000, 980000, 1090000].map((price, index) => {
    const letter = "ABCD"[index];
    return {
      id: `INT-LINER-${letter}`, supplierId: `SUP-00${index + 1}`, itemCode: "ITM-1001", unitPrice: price,
      conditions: { ...PRICE_SAMPLE_CONDITIONS, ...(letter === "D" ? { inspection: "전수 치수검사만(진원도 검사 미포함)" } : {}) },
      source: { documentId: `PRICE-INT-${letter}`, title: `가상 신규 협력사 견적 ${letter} 조건서`, date: "2026-10-15", page: "1" },
      isSample: true, kind: "supplier_quote", linkedContractId: `CT-2026-00${index + 1}`,
    };
  });
  inputs.externalQuotes = [980000, 1000000, 1020000].map((price, index) => ({
    id: `EXT-LINER-00${index + 1}`, itemCode: "ITM-1001", supplierName: `외부 견적 ${index + 1}(가상)`, unitPrice: price,
    conditions: { ...PRICE_SAMPLE_CONDITIONS },
    source: { documentId: `PRICE-EXT-00${index + 1}`, title: `가상 외부 완성부품 견적 ${index + 1} 조건서`, date: "2026-10-15", page: "1" },
    isSample: true, kind: "external_finished_quote",
  }));
  inputs.evidence = structuredClone(PRICE_SAMPLE_EVIDENCE);
  return inputs;
}
