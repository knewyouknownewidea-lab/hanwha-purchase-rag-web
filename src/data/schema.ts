// 업로드 데이터 표준 필드 정의 — 필드명·한글 헤더·별칭으로 자동 매핑한다
import type { DatasetKey } from "./types";

export type FieldType = "string" | "number" | "date" | "month" | "grade" | "list" | "boolean" | "history";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  aliases?: string[];
  min?: number;
  max?: number;
  defaultValue?: unknown;
  hint?: string;
}

export interface DatasetSchema {
  key: DatasetKey;
  label: string;
  /** 기본 키. 여러 열을 합쳐 한 행을 구분할 때는 배열 */
  primaryKey: string | string[];
  fields: FieldDef[];
}

export const pkFields = (schema: DatasetSchema): string[] => (Array.isArray(schema.primaryKey) ? schema.primaryKey : [schema.primaryKey]);
export const pkOf = (schema: DatasetSchema, row: Record<string, unknown>) => pkFields(schema).map((k) => String(row[k] ?? "")).join("|");

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  string: "문자",
  number: "숫자",
  date: "날짜(YYYY-MM-DD)",
  month: "월(YYYY-MM)",
  grade: "A~D",
  list: "목록(;)",
  boolean: "예/아니오",
  history: "기간:등급:점수[:사유];…",
};

export const SCHEMAS: Record<DatasetKey, DatasetSchema> = {
  suppliers: {
    key: "suppliers",
    label: "협력업체",
    primaryKey: "supplierId",
    fields: [
      { key: "supplierId", label: "업체ID", type: "string", required: true, aliases: ["협력사id", "업체코드", "협력사코드", "vendorid", "vendor_id", "id"] },
      { key: "name", label: "협력사명", type: "string", required: true, aliases: ["업체명", "회사명", "vendor", "vendorname"] },
      { key: "process", label: "공정 구분", type: "string", aliases: ["공정", "업종"] },
      { key: "region", label: "지역", type: "string", aliases: ["소재지"] },
      { key: "items", label: "공급 가능 품목", type: "list", aliases: ["공급품목", "품목코드", "품목"], hint: "품목코드를 ; 로 구분" },
      { key: "auditGrade", label: "심사 등급", type: "grade", aliases: ["등급", "평가등급", "심사등급"] },
      { key: "qualityScore", label: "품질 평가 점수", type: "number", min: 0, max: 100, aliases: ["품질점수", "품질평가점수"] },
      { key: "defectRate", label: "불량률(%)", type: "number", min: 0, max: 100, aliases: ["불량률"] },
      { key: "techScore", label: "기술·대응력 점수", type: "number", min: 0, max: 100, aliases: ["기술점수", "기술대응력", "대응력점수"] },
      { key: "esgScore", label: "경영·ESG 점수", type: "number", min: 0, max: 100, aliases: ["esg", "경영점수", "esg점수", "경영esg"] },
      { key: "lastAuditDate", label: "최근 심사일", type: "date", aliases: ["심사일"] },
      { key: "lastTradeDate", label: "최근 거래일", type: "date", aliases: ["거래일"] },
      { key: "evalHistory", label: "평가 이력", type: "history", aliases: ["평가이력"], hint: "2025H1:B:84:사유;2025H2:B:83 또는 2024:A:88" },
    ],
  },
  items: {
    key: "items",
    label: "품목 마스터",
    primaryKey: "itemCode",
    fields: [
      { key: "itemCode", label: "품목코드", type: "string", required: true, aliases: ["품번", "자재코드", "itemno", "partno"] },
      { key: "name", label: "품목명", type: "string", required: true, aliases: ["자재명", "품명"] },
      { key: "spec", label: "규격", type: "string", aliases: ["사양"] },
      { key: "category", label: "분류", type: "string", aliases: ["품목분류"] },
      { key: "unit", label: "단위", type: "string" },
      { key: "criticality", label: "중요도", type: "string" },
      { key: "leadTimeDays", label: "표준 리드타임(일)", type: "number", min: 0, aliases: ["리드타임"] },
      { key: "materials", label: "주요 소재", type: "list", aliases: ["소재", "재질", "원자재"], hint: "원자재 이름을 ; 로 구분 (원자재 시세와 같은 이름)" },
    ],
  },
  purchaseOrders: {
    key: "purchaseOrders",
    label: "구매조달(발주)",
    primaryKey: "poNo",
    fields: [
      { key: "poNo", label: "발주번호", type: "string", required: true, aliases: ["po", "po번호", "발주no"] },
      { key: "itemCode", label: "품목코드", type: "string", required: true, aliases: ["품번", "자재코드"] },
      { key: "supplierId", label: "업체ID", type: "string", required: true, aliases: ["협력사id", "발주업체", "업체코드"] },
      { key: "qty", label: "발주 수량", type: "number", required: true, min: 0, aliases: ["수량", "발주수량"] },
      { key: "unitPrice", label: "발주 단가", type: "number", min: 0, aliases: ["단가"] },
      { key: "currency", label: "통화", type: "string", defaultValue: "KRW", aliases: ["거래통화"] },
      { key: "orderDate", label: "발주 일자", type: "date", required: true, aliases: ["발주일", "발주일자"] },
      { key: "dueDate", label: "납기 예정일", type: "date", required: true, aliases: ["납기일", "납기", "납기예정일"] },
      { key: "receivedDate", label: "실제 입고일", type: "date", aliases: ["입고일", "실입고일"] },
      { key: "canceled", label: "취소 여부", type: "boolean", aliases: ["취소"] },
    ],
  },
  contracts: {
    key: "contracts",
    label: "원가-계약",
    primaryKey: "contractId",
    fields: [
      { key: "contractId", label: "계약번호", type: "string", required: true, aliases: ["계약id", "계약no"] },
      { key: "itemCode", label: "품목코드", type: "string", required: true, aliases: ["품번"] },
      { key: "supplierId", label: "업체ID", type: "string", required: true, aliases: ["협력사id", "거래협력사"] },
      { key: "spec", label: "규격", type: "string" },
      { key: "unitPrice", label: "최근 단가", type: "number", required: true, min: 0, aliases: ["단가", "계약단가"] },
      { key: "prevUnitPrice", label: "과거 단가", type: "number", min: 0, aliases: ["직전단가", "이전단가"] },
      { key: "currency", label: "거래 통화", type: "string", defaultValue: "KRW", aliases: ["통화"] },
      { key: "deliveryTerms", label: "인도 조건", type: "string", aliases: ["인도조건", "incoterms"] },
      { key: "paymentTerms", label: "결제 조건", type: "string", aliases: ["결제조건", "계약조건"], hint: "예: 월말 마감 60일 / 월말 마감 익월 20일 / 입고 후 30일" },
      { key: "startDate", label: "계약 시작일", type: "date", aliases: ["시작일"] },
      { key: "endDate", label: "계약 종료일", type: "date", aliases: ["종료일", "만료일"] },
    ],
  },
  inventory: {
    key: "inventory",
    label: "자재-공급관리(재고)",
    primaryKey: "itemCode",
    fields: [
      { key: "itemCode", label: "품목코드", type: "string", required: true, aliases: ["품번", "자재코드"] },
      { key: "stockQty", label: "현재 재고량", type: "number", required: true, min: 0, aliases: ["재고", "재고량", "현재고"] },
      { key: "safetyStock", label: "안전재고 기준", type: "number", required: true, min: 0, aliases: ["안전재고"] },
      { key: "mainSupplierId", label: "주 공급업체ID", type: "string", aliases: ["공급업체", "공급업체id"] },
      { key: "location", label: "보관 위치", type: "string", aliases: ["위치", "창고"] },
    ],
  },
  bom: {
    key: "bom",
    label: "부품 분류(BOM 경로)",
    primaryKey: ["engineModel", "itemCode"],
    fields: [
      { key: "engineModel", label: "엔진 모델", type: "string", required: true, aliases: ["엔진", "엔진모델", "기종", "모델"] },
      { key: "major", label: "대부품", type: "string", required: true, aliases: ["대분류", "대부품군"] },
      { key: "mid", label: "중부품", type: "string", required: true, aliases: ["중분류", "어셈블리"] },
      { key: "minor", label: "소부품", type: "string", required: true, aliases: ["소분류", "부품명"] },
      { key: "itemCode", label: "품목코드", type: "string", required: true, aliases: ["품번", "자재코드"] },
    ],
  },
  materialPrices: {
    key: "materialPrices",
    label: "원자재 시세",
    primaryKey: ["month", "material", "market"],
    fields: [
      { key: "month", label: "기준월", type: "month", required: true, aliases: ["월", "날짜", "일자", "기간"] },
      { key: "material", label: "원자재", type: "string", required: true, aliases: ["자재", "원자재명", "소재"] },
      { key: "market", label: "시장", type: "string", required: true, aliases: ["구분", "국제국내"], hint: "국제 또는 국내" },
      { key: "price", label: "가격", type: "number", required: true, min: 0, aliases: ["시세", "단가"] },
      { key: "unit", label: "단위", type: "string", defaultValue: "톤", hint: "톤 또는 kg" },
      { key: "currency", label: "통화", type: "string", defaultValue: "KRW", hint: "USD 또는 KRW" },
      { key: "source", label: "출처", type: "string" },
    ],
  },
  fxRates: {
    key: "fxRates",
    label: "환율",
    primaryKey: ["month", "currency"],
    fields: [
      { key: "month", label: "기준월", type: "month", required: true, aliases: ["월", "날짜"] },
      { key: "currency", label: "통화", type: "string", defaultValue: "USD" },
      { key: "krw", label: "원화 환율", type: "number", required: true, min: 0, aliases: ["환율", "원달러", "매매기준율"], hint: "1 통화 단위당 원" },
      { key: "source", label: "출처", type: "string" },
    ],
  },
  laborWages: {
    key: "laborWages",
    label: "인건비(임금)",
    primaryKey: ["month", "major", "mid", "minor"],
    fields: [
      { key: "month", label: "기준월", type: "month", required: true, aliases: ["월", "기간"] },
      { key: "major", label: "대분류", type: "string", required: true },
      { key: "mid", label: "중분류", type: "string", required: true },
      { key: "minor", label: "소분류", type: "string", required: true, aliases: ["직종"] },
      { key: "wage", label: "월평균 임금(원)", type: "number", required: true, min: 0, aliases: ["임금", "평균임금", "월임금"] },
      { key: "source", label: "출처", type: "string" },
    ],
  },
  competitorSupply: {
    key: "competitorSupply",
    label: "경쟁사 공급 동향",
    primaryKey: ["competitor", "itemCode", "supplierName"],
    fields: [
      { key: "competitor", label: "경쟁사", type: "string", required: true, aliases: ["경쟁업체"] },
      { key: "itemCode", label: "품목코드", type: "string", required: true, aliases: ["관련품목", "품번"] },
      { key: "supplierName", label: "공급처", type: "string", required: true, aliases: ["공급업체", "공급사", "협력사"] },
      { key: "supplierId", label: "공급처 업체ID", type: "string", aliases: ["업체id"], hint: "우리 협력사이면 업체ID" },
      { key: "demand", label: "수요 내용", type: "string", aliases: ["수요", "내용"] },
      { key: "period", label: "시기", type: "string" },
      { key: "date", label: "확인일", type: "date", aliases: ["일자"] },
      { key: "source", label: "출처", type: "string" },
      { key: "sourceUrl", label: "출처 링크", type: "string", aliases: ["url", "링크"] },
    ],
  },
  industryNews: {
    key: "industryNews",
    label: "업계 동향",
    primaryKey: ["date", "title"],
    fields: [
      { key: "date", label: "날짜", type: "date", required: true, aliases: ["일자", "게재일"] },
      { key: "title", label: "제목", type: "string", required: true },
      { key: "summary", label: "요약", type: "string", aliases: ["내용"] },
      { key: "items", label: "관련 품목", type: "list", aliases: ["품목코드", "관련품목"], hint: "품목코드를 ; 로 구분" },
      { key: "materials", label: "관련 원자재", type: "list", aliases: ["원자재"], hint: "원자재 이름을 ; 로 구분" },
      { key: "source", label: "출처", type: "string", aliases: ["매체"] },
      { key: "sourceUrl", label: "출처 링크", type: "string", aliases: ["url", "링크"] },
    ],
  },
};
