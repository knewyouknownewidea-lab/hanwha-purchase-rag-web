// 데이터 계층: 플랫폼이 다루는 데이터와 공통 식별자
// 연결 키 — supplierId(협력사), itemCode(품목), poNo(발주), contractId(계약)

export type Grade = "A" | "B" | "C" | "D";

export interface EvalHistoryEntry {
  year: number;
  half?: 1 | 2 | null; // 1 = 상반기, 2 = 하반기 (없으면 연간 평가)
  grade: Grade;
  score: number;
  reason?: string | null; // 등급 변동 사유 (기록이 있을 때만)
}

export interface Supplier {
  supplierId: string;
  name: string;
  process?: string;
  region?: string;
  items: string[]; // 공급 가능 품목 코드
  auditGrade?: Grade | null; // 최근 심사 등급(입력값)
  qualityScore?: number | null; // 품질 평가 점수(입고검사 기반, 100점)
  defectRate?: number | null; // 불량률(%)
  techScore?: number | null; // 기술·대응력(심사 입력값)
  esgScore?: number | null; // 경영·ESG(심사 입력값)
  lastAuditDate?: string | null;
  lastTradeDate?: string | null; // 입력값이 있으면 사용, 없으면 발주 이력에서 계산
  evalHistory: EvalHistoryEntry[];
}

export interface Item {
  itemCode: string;
  name: string;
  spec?: string;
  category?: string;
  unit?: string;
  criticality?: string;
  leadTimeDays?: number | null;
  materials?: string[]; // 주요 소재(원자재 이름) — 원자재 시세와 연결
}

export interface PurchaseOrder {
  poNo: string;
  itemCode: string;
  supplierId: string;
  qty: number;
  unitPrice?: number | null;
  currency: string;
  orderDate: string;
  dueDate: string;
  receivedDate?: string | null;
  canceled?: boolean;
}

export interface Contract {
  contractId: string;
  itemCode: string;
  supplierId: string;
  spec?: string;
  unitPrice: number;
  prevUnitPrice?: number | null;
  currency: string;
  deliveryTerms?: string;
  paymentTerms?: string;
  startDate?: string | null;
  endDate?: string | null;
}

export interface InventoryRecord {
  itemCode: string;
  stockQty: number;
  safetyStock: number;
  mainSupplierId?: string | null;
  location?: string;
}

/** 부품 분류 경로: 엔진 모델 > 대부품 > 중부품 > 소부품(품목) */
export interface BomRow {
  engineModel: string;
  major: string;
  mid: string;
  minor: string;
  itemCode: string;
}

/** 원자재 시세 (월별). 국제 시세는 보통 USD/톤, 국내 시세는 원/kg */
export interface MaterialPrice {
  month: string; // YYYY-MM
  material: string;
  market: string; // "국제" | "국내"
  price: number;
  unit: string; // "톤" | "kg"
  currency: string; // "USD" | "KRW"
  source?: string | null;
}

/** 월평균 환율 (1 통화 단위당 원) */
export interface FxRate {
  month: string;
  currency: string;
  krw: number;
  source?: string | null;
}

/** 직종별 월평균 임금 (대·중·소 분류) */
export interface LaborWage {
  month: string;
  major: string;
  mid: string;
  minor: string;
  wage: number; // 원/월
  source?: string | null;
}

/** 경쟁사의 부품 수요와 공급처 (공개 자료 기준) */
export interface CompetitorSupply {
  competitor: string;
  itemCode: string;
  supplierName: string;
  supplierId?: string | null; // 우리 협력사이면 업체ID
  demand?: string | null;
  period?: string | null;
  date?: string | null;
  source?: string | null;
  sourceUrl?: string | null;
}

/** 업계 동향 기사·자료 */
export interface IndustryNews {
  date: string;
  title: string;
  summary?: string | null;
  items: string[];
  materials: string[];
  source?: string | null;
  sourceUrl?: string | null;
}

export type DatasetKey =
  | "suppliers"
  | "items"
  | "purchaseOrders"
  | "contracts"
  | "inventory"
  | "bom"
  | "materialPrices"
  | "fxRates"
  | "laborWages"
  | "competitorSupply"
  | "industryNews";

export interface DataSet {
  suppliers: Supplier[];
  items: Item[];
  purchaseOrders: PurchaseOrder[];
  contracts: Contract[];
  inventory: InventoryRecord[];
  bom: BomRow[];
  materialPrices: MaterialPrice[];
  fxRates: FxRate[];
  laborWages: LaborWage[];
  competitorSupply: CompetitorSupply[];
  industryNews: IndustryNews[];
}

export interface DataMeta {
  label: string; // 예: "SAMPLE · 시연용 가상 데이터"
  asOf: string; // 데이터 기준일
  isSample: boolean;
  sources: Partial<Record<DatasetKey, string>>; // 데이터별 출처(파일명 등)
  version: number; // 데이터가 바뀔 때마다 증가
  dataId: string; // 데이터 묶음 식별값: 샘플은 "sample", 업로드할 때마다 새 값 → 재분석 필요 여부 판단
  uploaded?: DatasetKey[]; // 업로드로 바뀐 데이터 종류
}

export const DATASET_LABEL: Record<DatasetKey, string> = {
  suppliers: "협력업체",
  items: "품목 마스터",
  purchaseOrders: "구매조달(발주)",
  contracts: "원가-계약",
  inventory: "자재-공급관리(재고)",
  bom: "부품 분류(BOM 경로)",
  materialPrices: "원자재 시세",
  fxRates: "환율",
  laborWages: "인건비(임금)",
  competitorSupply: "경쟁사 공급 동향",
  industryNews: "업계 동향",
};

export const DATASET_ORDER: DatasetKey[] = [
  "suppliers",
  "purchaseOrders",
  "contracts",
  "inventory",
  "items",
  "bom",
  "materialPrices",
  "fxRates",
  "laborWages",
  "competitorSupply",
  "industryNews",
];

export type TabKey = "suppliers" | "purchaseOrders" | "contracts" | "inventory";

export const TAB_LABEL: Record<TabKey, string> = {
  suppliers: "협력업체",
  purchaseOrders: "구매조달",
  contracts: "원가-계약",
  inventory: "자재-공급관리",
};

/** 탭 안의 하위 보기 (기본은 첫 번째 = 목록) */
export const SUB_VIEWS: Record<TabKey, { id: string; label: string; dataset: DatasetKey }[]> = {
  suppliers: [{ id: "list", label: "협력사 목록", dataset: "suppliers" }],
  purchaseOrders: [
    { id: "list", label: "발주 목록", dataset: "purchaseOrders" },
    { id: "payments", label: "대금 결제 일정", dataset: "contracts" },
  ],
  contracts: [
    { id: "list", label: "계약 단가", dataset: "contracts" },
    { id: "materials", label: "원자재 시세", dataset: "materialPrices" },
    { id: "wages", label: "인건비 동향", dataset: "laborWages" },
  ],
  inventory: [
    { id: "list", label: "재고·공급", dataset: "inventory" },
    { id: "competitors", label: "경쟁사 공급 동향", dataset: "competitorSupply" },
    { id: "news", label: "업계 동향", dataset: "industryNews" },
  ],
};

export const halfLabel = (h: Pick<EvalHistoryEntry, "year" | "half">, short = false) =>
  h.half ? `${short ? String(h.year).slice(2) : h.year}${short ? (h.half === 1 ? "상" : "하") : h.half === 1 ? " 상반기" : " 하반기"}` : `${short ? String(h.year).slice(2) + "년" : h.year + "년"}`;
