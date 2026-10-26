// SAMPLE 데이터 생성기 — 시연용 가상 데이터를 만든다.
// 실행: node scripts/generate-sample.mjs  →  src/data/sample/*.json
// 업체명·품목·수치는 모두 가상이며 실제 회사 데이터가 아니다.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "sample");
mkdirSync(OUT, { recursive: true });

const AS_OF = "2026-10-15";

// 시드 고정 난수 (같은 결과를 재현)
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261015);
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const DAY = 86400000;
const toDate = (s) => new Date(s + "T00:00:00Z");
const fmt = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => fmt(new Date(toDate(s).getTime() + n * DAY));

const items = [
  { itemCode: "ITM-1001", name: "실린더 라이너", spec: "Ø500 × 2,100mm, 특수주철", category: "주조품", unit: "EA", criticality: "상", lead: 75, qty: [4, 12] },
  { itemCode: "ITM-1002", name: "피스톤 링 세트", spec: "Ø500, 4본 1조", category: "정밀가공품", unit: "SET", criticality: "상", lead: 60, qty: [10, 30] },
  { itemCode: "ITM-1003", name: "배기밸브 스핀들", spec: "L=1,450mm, 내열합금 페이스", category: "단조·가공품", unit: "EA", criticality: "상", lead: 90, qty: [4, 10] },
  { itemCode: "ITM-1004", name: "연료분사밸브 노즐", spec: "9홀, Ø0.85", category: "정밀가공품", unit: "EA", criticality: "상", lead: 45, qty: [20, 60] },
  { itemCode: "ITM-1005", name: "메인 베어링 쉘", spec: "Ø560, 상하 1조", category: "정밀가공품", unit: "SET", criticality: "중", lead: 60, qty: [4, 12] },
  { itemCode: "ITM-1006", name: "커넥팅로드 볼트", spec: "M64 × 520mm", category: "체결부품", unit: "EA", criticality: "중", lead: 30, qty: [40, 120] },
  { itemCode: "ITM-1007", name: "실린더 커버 가스켓", spec: "Ø720, 연철", category: "소모성 부품", unit: "EA", criticality: "하", lead: 20, qty: [50, 200] },
  { itemCode: "ITM-1008", name: "냉각수 펌프 임펠러", spec: "Ø310, 청동 주물", category: "주조품", unit: "EA", criticality: "중", lead: 45, qty: [6, 16] },
  { itemCode: "ITM-1009", name: "고압 연료관", spec: "이중관, 2.4m", category: "배관 부품", unit: "EA", criticality: "중", lead: 40, qty: [10, 30] },
  { itemCode: "ITM-1010", name: "터보차저 노즐링", spec: "축류형, 33베인", category: "정밀가공품", unit: "EA", criticality: "상", lead: 90, qty: [2, 6] },
];

// 평가 이력: [기간, 등급, 점수, 사유?] — 기간은 2025H1(상반기) / 2025H2(하반기)
const hist = (rows) =>
  rows.map(([p, grade, score, reason]) => ({ year: Number(p.slice(0, 4)), half: p.endsWith("H1") ? 1 : 2, grade, score, ...(reason ? { reason } : {}) }));

const suppliers = [
  { supplierId: "SUP-001", name: "업체 A", process: "주조", region: "경남 창원", auditGrade: "A", qualityScore: 92, defectRate: 0.6, techScore: 85, esgScore: 80, lastAuditDate: "2024-05-21", evalHistory: hist([["2023H2","A",86],["2024H1","A",87],["2024H2","A",88],["2025H1","A",88],["2025H2","A",89]]) },
  { supplierId: "SUP-002", name: "업체 B", process: "주조", region: "경남 김해", auditGrade: "B", qualityScore: 80, defectRate: 1.5, techScore: 70, esgScore: 65, lastAuditDate: "2025-04-10", evalHistory: hist([["2023H2","B",80],["2024H1","B",81],["2024H2","B",82],["2025H1","B",82],["2025H2","B",83]]) },
  { supplierId: "SUP-003", name: "업체 C", process: "주조·가공", region: "부산", auditGrade: "A", qualityScore: 90, defectRate: 0.7, techScore: 88, esgScore: 84, lastAuditDate: "2024-09-03", evalHistory: hist([["2023H2","B",84],["2024H1","A",87,"가공 라인 안정화 후 불량률 개선"],["2024H2","A",89],["2025H1","A",89],["2025H2","A",90]]) },
  { supplierId: "SUP-004", name: "업체 D", process: "주조(해외)", region: "해외", auditGrade: "C", qualityScore: 80, defectRate: 1.6, techScore: 62, esgScore: null, lastAuditDate: "2026-02-17", evalHistory: hist([["2025H1","C",70,"신규 등록 · 초도 평가"],["2025H2","C",71]]) },
  { supplierId: "SUP-005", name: "업체 E", process: "정밀가공", region: "경남 창원", auditGrade: "A", qualityScore: 91, defectRate: 0.5, techScore: 86, esgScore: 82, lastAuditDate: "2023-11-14", evalHistory: hist([["2023H2","A",90],["2024H1","A",90],["2024H2","A",91],["2025H1","A",92],["2025H2","A",92]]) },
  { supplierId: "SUP-006", name: "업체 F", process: "정밀가공", region: "경북 구미", auditGrade: "B", qualityScore: 82, defectRate: 1.4, techScore: 80, esgScore: 70, lastAuditDate: "2025-06-02", evalHistory: hist([["2023H2","A",87],["2024H1","A",86],["2024H2","A",86],["2025H1","B",84,"납기 지연 증가 (반기 준수율 80%대)"],["2025H2","B",84]]) },
  { supplierId: "SUP-007", name: "업체 G", process: "단조·가공", region: "경남 창원", auditGrade: "A", qualityScore: 89, defectRate: 0.8, techScore: 84, esgScore: 78, lastAuditDate: "2024-03-28", evalHistory: hist([["2023H2","A",87],["2024H1","A",88],["2024H2","A",88],["2025H1","A",88],["2025H2","A",89]]) },
  { supplierId: "SUP-008", name: "업체 H", process: "정밀가공", region: "울산", auditGrade: "B", qualityScore: 81, defectRate: 1.4, techScore: 72, esgScore: 66, lastAuditDate: "2025-08-19", evalHistory: hist([["2023H2","A",85],["2024H1","B",84,"입고검사 불량률 상승"],["2024H2","B",84],["2025H1","B",83],["2025H2","B",83]]) },
  { supplierId: "SUP-009", name: "업체 I", process: "소모품", region: "부산", auditGrade: "B", qualityScore: 80, defectRate: 1.0, techScore: 70, esgScore: 68, lastAuditDate: "2025-10-07", evalHistory: hist([["2023H2","B",81],["2024H1","B",82],["2024H2","B",82],["2025H1","B",83],["2025H2","B",83]]) },
  { supplierId: "SUP-010", name: "업체 J", process: "배관", region: "울산", auditGrade: "C", qualityScore: 70, defectRate: 2.8, techScore: 62, esgScore: 55, lastAuditDate: "2026-03-11", evalHistory: hist([["2023H2","B",79],["2024H1","B",78],["2024H2","B",77],["2025H1","C",74,"고압 연료관 납기 지연 반복 · 불량률 2%대"],["2025H2","C",73]]) },
  { supplierId: "SUP-011", name: "업체 K", process: "정밀가공", region: "경남 함안", auditGrade: "A", qualityScore: 88, defectRate: 0.7, techScore: 87, esgScore: 81, lastAuditDate: "2024-07-30", evalHistory: hist([["2023H2","A",89],["2024H1","A",90],["2024H2","A",90],["2025H1","A",91],["2025H2","A",92]]) },
  { supplierId: "SUP-012", name: "업체 L", process: "단조", region: "경남 창원", auditGrade: "B", qualityScore: 85, defectRate: 0.9, techScore: 79, esgScore: 76, lastAuditDate: "2025-01-22", evalHistory: hist([["2023H2","B",82],["2024H1","B",83],["2024H2","B",84],["2025H1","B",84],["2025H2","A",86,"단조 설비 교체 후 품질 점수 개선"]]) },
];

// 업체·품목 거래 쌍: n=발주 건수, late=기한 초과 건수, overdueOpen=납기 경과 미입고 1건 여부,
// p=[2024 단가, 2025 단가, 2026 단가], cur=통화, terms=인도조건
const DOM = "창원 공장 도착도";
const pairs = [
  { s: "SUP-001", i: "ITM-1001", n: 30, late: 1, p: [1180000, 1210000, 1250000] },
  { s: "SUP-002", i: "ITM-1001", n: 26, late: 2, p: [1100000, 1120000, 1190000] },
  { s: "SUP-003", i: "ITM-1001", n: 20, late: 1, p: [1270000, 1290000, 1310000] },
  { s: "SUP-004", i: "ITM-1001", n: 8, late: 2, p: [870, 880, 905], cur: "USD", terms: "FOB 해외 선적항" },
  { s: "SUP-001", i: "ITM-1008", n: 10, late: 0, p: [420000, 428000, 438000] },
  { s: "SUP-002", i: "ITM-1008", n: 12, late: 1, p: [398000, 405000, 415000] },
  { s: "SUP-003", i: "ITM-1005", n: 12, late: 0, p: [2150000, 2180000, 2210000] },
  { s: "SUP-008", i: "ITM-1005", n: 14, late: 2, p: [2140000, 2190000, 2240000] },
  { s: "SUP-005", i: "ITM-1002", n: 18, late: 1, p: [3450000, 3480000, 3520000] },
  { s: "SUP-008", i: "ITM-1002", n: 16, late: 2, p: [3250000, 3300000, 3560000], overdueOpen: true },
  { s: "SUP-005", i: "ITM-1006", n: 10, late: 0, p: [185000, 188000, 192000] },
  { s: "SUP-007", i: "ITM-1006", n: 12, late: 1, p: [179000, 183000, 188000] },
  { s: "SUP-006", i: "ITM-1004", n: 24, late: 4, p: [620000, 640000, 720000], overdueOpen: true },
  { s: "SUP-008", i: "ITM-1004", n: 10, late: 1, p: [655000, 675000, 705000] },
  { s: "SUP-011", i: "ITM-1004", n: 14, late: 0, p: [670000, 684000, 698000] },
  { s: "SUP-006", i: "ITM-1010", n: 10, late: 2, p: [8900000, 9050000, 9300000] },
  { s: "SUP-011", i: "ITM-1010", n: 12, late: 0, p: [9100000, 9220000, 9350000] },
  { s: "SUP-007", i: "ITM-1003", n: 16, late: 1, p: [5200000, 5290000, 5380000] },
  { s: "SUP-012", i: "ITM-1003", n: 14, late: 1, p: [5050000, 5180000, 5290000] },
  { s: "SUP-009", i: "ITM-1007", n: 20, late: 2, p: [48000, 49000, 50000] },
  { s: "SUP-010", i: "ITM-1007", n: 10, late: 2, p: [46000, 47000, 49000] },
  { s: "SUP-010", i: "ITM-1009", n: 18, late: 5, p: [1320000, 1350000, 1520000], overdueOpen: true },
  { s: "SUP-012", i: "ITM-1009", n: 10, late: 1, p: [1420000, 1440000, 1455000] },
];

// 결제 조건 (거래 쌍 순서와 같음) — 결제 일정 계산 규칙은 src/lib/payments.ts
const PAY = [
  "월말 마감 60일", "월말 마감 익월 20일", "월말 마감 60일", "T/T 선적 후 30일",
  "입고 후 30일", "월말 마감 익월 20일", "월말 마감 45일", "월말 마감 60일",
  "입고 후 45일", "월말 마감 60일", "입고 후 30일", "월말 마감 45일",
  "월말 마감 60일", "월말 마감 60일", "입고 후 30일", "분할 결제 (선급 30% · 잔금 별도 협의)",
  "월말 마감 60일", "월말 마감 45일", "월말 마감 익월 20일", "입고 후 30일",
  "월말 마감 60일", "월말 마감 60일", "월말 마감 익월 20일",
];

const START = "2024-01-08";
const END_ORDER = "2026-09-28";
const span = (toDate(END_ORDER) - toDate(START)) / DAY;

const rawPOs = [];
for (const pr of pairs) {
  const item = items.find((x) => x.itemCode === pr.i);
  const orders = [];
  for (let k = 0; k < pr.n; k++) {
    const base = Math.round((span * (k + 0.5)) / pr.n);
    const jitter = randInt(-9, 9);
    const orderDate = addDays(START, Math.max(0, Math.min(span, base + jitter)));
    const dueDate = addDays(orderDate, item.lead + randInt(-5, 5));
    orders.push({ orderDate, dueDate });
  }
  orders.sort((a, b) => a.orderDate.localeCompare(b.orderDate));
  const closed = orders.map((o, idx) => ({ ...o, idx })).filter((o) => o.dueDate <= AS_OF);
  // 기한 초과 대상 선택: overdueOpen이면 가장 최근 마감분 1건을 미입고 지연으로 둔다
  const lateSet = new Set();
  if (pr.overdueOpen && closed.length) lateSet.add(closed[closed.length - 1].idx);
  while (lateSet.size < Math.min(pr.late, closed.length)) {
    lateSet.add(closed[randInt(0, closed.length - 1)].idx);
  }
  orders.forEach((o, idx) => {
    const year = Number(o.orderDate.slice(0, 4));
    const price = pr.p[Math.min(2, Math.max(0, year - 2024))];
    let receivedDate = null;
    if (o.dueDate <= AS_OF) {
      if (lateSet.has(idx)) {
        const isOverdueOpen = pr.overdueOpen && idx === closed[closed.length - 1].idx;
        receivedDate = isOverdueOpen ? null : addDays(o.dueDate, randInt(4, 21));
        if (receivedDate && receivedDate > AS_OF) receivedDate = null;
      } else {
        receivedDate = addDays(o.dueDate, -randInt(0, 6));
      }
    }
    rawPOs.push({
      itemCode: pr.i,
      supplierId: pr.s,
      qty: randInt(item.qty[0], item.qty[1]),
      unitPrice: price,
      currency: pr.cur || "KRW",
      orderDate: o.orderDate,
      dueDate: o.dueDate,
      receivedDate,
    });
  });
}
rawPOs.sort((a, b) => a.orderDate.localeCompare(b.orderDate) || a.supplierId.localeCompare(b.supplierId));
const yearSeq = {};
const purchaseOrders = rawPOs.map((po) => {
  const y = po.orderDate.slice(0, 4);
  yearSeq[y] = (yearSeq[y] || 0) + 1;
  return { poNo: `PO-${y}-${String(yearSeq[y]).padStart(4, "0")}`, ...po };
});

const contracts = pairs.map((pr, k) => {
  const item = items.find((x) => x.itemCode === pr.i);
  return {
    contractId: `CT-2026-${String(k + 1).padStart(3, "0")}`,
    itemCode: pr.i,
    supplierId: pr.s,
    spec: item.spec,
    unitPrice: pr.p[2],
    prevUnitPrice: pr.p[1],
    currency: pr.cur || "KRW",
    deliveryTerms: pr.terms || DOM,
    paymentTerms: PAY[k],
    startDate: "2026-01-01",
    endDate: pr.s === "SUP-010" || pr.s === "SUP-006" ? "2026-11-30" : "2026-12-31",
  };
});

const inventory = [
  { itemCode: "ITM-1001", stockQty: 18, safetyStock: 12, mainSupplierId: "SUP-001", location: "자재창고 A동" },
  { itemCode: "ITM-1002", stockQty: 64, safetyStock: 40, mainSupplierId: "SUP-005", location: "자재창고 B동" },
  { itemCode: "ITM-1003", stockQty: 9, safetyStock: 10, mainSupplierId: "SUP-007", location: "자재창고 A동" },
  { itemCode: "ITM-1004", stockQty: 85, safetyStock: 120, mainSupplierId: "SUP-006", location: "정밀부품 보관실" },
  { itemCode: "ITM-1005", stockQty: 22, safetyStock: 16, mainSupplierId: "SUP-003", location: "자재창고 B동" },
  { itemCode: "ITM-1006", stockQty: 340, safetyStock: 200, mainSupplierId: "SUP-005", location: "자재창고 C동" },
  { itemCode: "ITM-1007", stockQty: 520, safetyStock: 400, mainSupplierId: "SUP-009", location: "자재창고 C동" },
  { itemCode: "ITM-1008", stockQty: 14, safetyStock: 10, mainSupplierId: "SUP-001", location: "자재창고 A동" },
  { itemCode: "ITM-1009", stockQty: 21, safetyStock: 30, mainSupplierId: "SUP-010", location: "배관자재 야적장" },
  { itemCode: "ITM-1010", stockQty: 7, safetyStock: 6, mainSupplierId: "SUP-011", location: "정밀부품 보관실" },
];

// 공급 가능 품목은 거래 쌍에서 채운다
const supplierRows = suppliers.map((s) => ({
  ...s,
  items: pairs.filter((p) => p.s === s.supplierId).map((p) => p.i),
}));

// 부품별 대표 소재 (일반적인 2행정 저속 엔진 기준 예시, SAMPLE) — 원자재 시세와 이름으로 연결
const MATERIALS = {
  "ITM-1001": ["선철", "철스크랩", "몰리브덴"], // 합금 주철 라이너
  "ITM-1002": ["선철", "크롬"], // 주철 링 + 크롬 세라믹 코팅
  "ITM-1003": ["니켈", "크롬"], // 니켈계 초내열합금(예: Nimonic 80A) 스핀들
  "ITM-1004": ["크롬", "몰리브덴", "철스크랩"], // 고합금강 노즐
  "ITM-1005": ["주석", "구리", "철스크랩"], // 강 쉘 + 화이트메탈 라이닝
  "ITM-1006": ["철스크랩", "크롬", "몰리브덴"], // 고장력 합금강(Cr-Mo) 볼트
  "ITM-1007": ["철스크랩"], // 연철 가스켓
  "ITM-1008": ["구리", "주석"], // 청동 주물 임펠러
  "ITM-1009": ["철스크랩", "니켈", "크롬"], // 이중 고압 강관
  "ITM-1010": ["크롬", "니켈"], // 내열 주강 노즐링
};
const itemRows = items.map(({ lead, qty, ...rest }) => ({ ...rest, leadTimeDays: lead, materials: MATERIALS[rest.itemCode] }));

// ─────────────────────────────────────────────────────────────
// v0.3 추가 데이터 (기존 발주·계약 데이터가 바뀌지 않도록 별도 난수 사용)
// ─────────────────────────────────────────────────────────────
const rand2 = mulberry32(20261016);
const noise = (amp) => (rand2() * 2 - 1) * amp;

// 부품 분류(BOM 경로): 엔진 모델 > 대부품 > 중부품 > 소부품(구매 품목)
// 대부품 구분은 2행정 저속 엔진 정비 매뉴얼의 그룹 구성(베드플레이트·실린더부·운동부·연료 공급부·소기 계통·배관)을 참고한 예시
const ENGINES = ["SAMPLE 엔진 X형", "SAMPLE 엔진 Y형"];
const BOM_PATHS = [
  ["ITM-1005", "기관 본체 (베드플레이트·프레임)", "메인 베어링 어셈블리", "메인 베어링 쉘"],
  ["ITM-1001", "실린더부 (라이너·커버·배기밸브)", "실린더 라이너 어셈블리", "실린더 라이너"],
  ["ITM-1007", "실린더부 (라이너·커버·배기밸브)", "실린더 커버 어셈블리", "실린더 커버 가스켓"],
  ["ITM-1003", "실린더부 (라이너·커버·배기밸브)", "배기밸브 어셈블리", "배기밸브 스핀들"],
  ["ITM-1002", "운동부 (크랭크축·커넥팅로드·피스톤)", "피스톤 어셈블리", "피스톤 링 세트"],
  ["ITM-1006", "운동부 (크랭크축·커넥팅로드·피스톤)", "커넥팅로드 어셈블리", "커넥팅로드 볼트"],
  ["ITM-1004", "연료·유압 공급부", "연료분사밸브 어셈블리", "연료분사밸브 노즐"],
  ["ITM-1009", "연료·유압 공급부", "고압 연료 배관", "고압 연료관"],
  ["ITM-1010", "소기·과급부", "과급기 (터보차저)", "터보차저 노즐링"],
  ["ITM-1008", "배관·냉각부", "냉각수 펌프", "냉각수 펌프 임펠러"],
];
const ONLY = { "ITM-1008": ["SAMPLE 엔진 X형"], "ITM-1009": ["SAMPLE 엔진 Y형"] }; // 한 엔진에만 쓰이는 예시
const bom = [];
for (const engineModel of ENGINES)
  for (const [itemCode, major, mid, minor] of BOM_PATHS)
    if (!ONLY[itemCode] || ONLY[itemCode].includes(engineModel)) bom.push({ engineModel, major, mid, minor, itemCode });

// 월 목록: 기준일 직전 달까지 24개월
const months = [];
{
  const d = new Date(Date.UTC(2024, 9, 1)); // 2024-10
  for (let i = 0; i < 24; i++) {
    months.push(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
}

// 환율 (SAMPLE) — 원/달러 월평균
const fxRates = [];
{
  months.forEach((m, i) => {
    const v = 1362 + i * 2.4 + noise(7);
    fxRates.push({ month: m, currency: "USD", krw: Math.round(v * 10) / 10, source: "SAMPLE (가상 값)" });
  });
}
const fxOf = (m) => fxRates.find((f) => f.month === m).krw;

// 원자재 시세 (SAMPLE) — 국제: USD/톤, 국내: 원/kg. 추세는 시연을 위해 원자재마다 다르게 둔다.
const MAT = [
  { name: "선철", intl: 430, drift: [0.002, -0.004], vol: 0.018, prem: 0.08 },
  { name: "철스크랩", intl: 365, drift: [0.003, -0.009], vol: 0.025, prem: 0.12 },
  { name: "니켈", intl: 15800, drift: [-0.006, 0.019], vol: 0.03, prem: 0.05 },
  { name: "크롬", intl: 2280, drift: [0.001, 0.003], vol: 0.012, prem: 0.07 },
  { name: "몰리브덴", intl: 46000, drift: [0.006, 0.011], vol: 0.028, prem: 0.06 },
  { name: "구리", intl: 9400, drift: [0.004, 0.012], vol: 0.02, prem: 0.04 },
  { name: "주석", intl: 31000, drift: [0.003, 0.011], vol: 0.03, prem: 0.05 },
];
const materialPrices = [];
for (const mt of MAT) {
  let usd = mt.intl;
  months.forEach((m, i) => {
    const drift = i < 12 ? mt.drift[0] : mt.drift[1];
    usd = usd * (1 + drift + noise(mt.vol));
    const intlRounded = Math.round(usd / (usd > 10000 ? 10 : 1)) * (usd > 10000 ? 10 : 1);
    materialPrices.push({ month: m, material: mt.name, market: "국제", price: intlRounded, unit: "톤", currency: "USD", source: "SAMPLE (가상 값)" });
    const krwPerKg = (intlRounded * fxOf(m)) / 1000;
    const domestic = krwPerKg * (1 + mt.prem + noise(0.02));
    const step = domestic > 10000 ? 50 : domestic > 1000 ? 10 : 1;
    materialPrices.push({ month: m, material: mt.name, market: "국내", price: Math.round(domestic / step) * step, unit: "kg", currency: "KRW", source: "SAMPLE (가상 값)" });
  });
}

// 인건비 (SAMPLE) — 직종 대·중·소 분류, 월평균 임금(원). 대분류 이름은 한국표준직업분류 대분류를 참고했다.
const WAGE_TREE = [
  ["기능원 및 관련 기능 종사자", "금속 성형 기능직", "주조원", 3920000, 0.062],
  ["기능원 및 관련 기능 종사자", "금속 성형 기능직", "단조원", 4010000, 0.048],
  ["기능원 및 관련 기능 종사자", "금속 성형 기능직", "용접원", 4180000, 0.051],
  ["기능원 및 관련 기능 종사자", "기계 조립·정비 기능직", "엔진·기계 조립원", 3840000, 0.037],
  ["기능원 및 관련 기능 종사자", "기계 조립·정비 기능직", "배관원", 3960000, 0.042],
  ["장치·기계 조작 및 조립 종사자", "금속 가공 기계 조작직", "CNC 공작기계 조작원", 3870000, 0.039],
  ["장치·기계 조작 및 조립 종사자", "금속 가공 기계 조작직", "연삭·정밀가공 조작원", 3790000, 0.035],
  ["장치·기계 조작 및 조립 종사자", "금속 가공 기계 조작직", "열처리 조작원", 3710000, 0.044],
  ["장치·기계 조작 및 조립 종사자", "금속 가공 기계 조작직", "프레스·판금 조작원", 3520000, 0.031],
  ["장치·기계 조작 및 조립 종사자", "표면처리 조작직", "도장기 조작원", 3610000, 0.033],
  ["전문가 및 관련 종사자", "품질·검사 기술직", "비파괴검사원", 4320000, 0.046],
  ["전문가 및 관련 종사자", "품질·검사 기술직", "품질 검사원", 3730000, 0.034],
];
const laborWages = [];
for (const [major, mid, minor, base, yoy] of WAGE_TREE) {
  let level = base / (1 + yoy); // 첫 해 1월 인상 전 수준
  months.forEach((m) => {
    if (m.endsWith("-01")) level = level * (1 + yoy + noise(0.006)); // 매년 1월 임금 인상
    const monthly = level * (1 + noise(0.004) + (m.endsWith("-12") ? 0.018 : 0)); // 연말 특근 반영
    laborWages.push({ month: m, major, mid, minor, wage: Math.round(monthly / 1000) * 1000, source: "SAMPLE (가상 값)" });
  });
}

// 경쟁사 부품 수요·공급처 (SAMPLE) — 회사명은 모두 가상이며 실제 회사가 아니다.
const competitorSupply = [
  { competitor: "가온중공업 엔진사업부(가상)", itemCode: "ITM-1001", supplierName: "업체 B", supplierId: "SUP-002", demand: "2026년 하반기 2행정 엔진 수주 증가로 라이너 발주 확대 예상", period: "2026년 하반기", date: "2026-09-18" },
  { competitor: "가온중공업 엔진사업부(가상)", itemCode: "ITM-1004", supplierName: "업체 F", supplierId: "SUP-006", demand: "이중연료 엔진용 노즐 신규 승인 진행", period: "2026년 4분기", date: "2026-09-30" },
  { competitor: "가온중공업 엔진사업부(가상)", itemCode: "ITM-1002", supplierName: "세광링텍(가상)", supplierId: null, demand: "피스톤 링 연간 단가 계약 갱신", period: "2027년", date: "2026-08-27" },
  { competitor: "서진마린엔진(가상)", itemCode: "ITM-1010", supplierName: "한빛정밀(가상)", supplierId: null, demand: "과급기 노즐링 장기 공급 계약 체결", period: "2026~2028년", date: "2026-07-14" },
  { competitor: "서진마린엔진(가상)", itemCode: "ITM-1003", supplierName: "업체 L", supplierId: "SUP-012", demand: "배기밸브 스핀들 물량 30% 증량 요청", period: "2026년 하반기", date: "2026-09-05" },
  { competitor: "동해파워텍(가상)", itemCode: "ITM-1009", supplierName: "업체 J", supplierId: "SUP-010", demand: "고압 연료관 긴급 발주 (납기 단축 요청)", period: "2026년 4분기", date: "2026-10-02" },
  { competitor: "동해파워텍(가상)", itemCode: "ITM-1005", supplierName: "대륙베어링(가상)", supplierId: null, demand: "메인 베어링 쉘 국산화 시험 발주", period: "2027년 상반기", date: "2026-08-11" },
].map((r) => ({ ...r, source: "SAMPLE (가상 자료)", sourceUrl: null }));

// 업계 동향 (SAMPLE 기사) — 실제 기사가 아니다.
const industryNews = [
  { date: "2026-10-08", title: "니켈 강세 지속… 내열합금 부품 원가 부담 커져", summary: "니켈 국제 시세가 1년 전보다 크게 오른 수준을 유지하며 배기밸브 스핀들·노즐링 등 니켈계 내열합금 부품의 원가 상승 요인이 커지고 있다.", items: ["ITM-1003", "ITM-1010", "ITM-1009"], materials: ["니켈"] },
  { date: "2026-09-24", title: "이중연료 엔진 수주 증가로 연료분사 부품 수요 확대 전망", summary: "이중연료 엔진 비중이 늘면서 연료분사밸브 노즐과 고압 연료관 수요가 함께 늘 것으로 보인다.", items: ["ITM-1004", "ITM-1009"], materials: [] },
  { date: "2026-09-15", title: "주물업계 숙련 인력 부족 심화, 주조원 임금 상승세", summary: "숙련 주조 인력이 부족해 임금이 오르고 있으며, 주조품 가공비 인상 요청이 늘 수 있다.", items: ["ITM-1001", "ITM-1008"], materials: ["선철", "철스크랩"] },
  { date: "2026-09-02", title: "철스크랩 가격 약보합… 주조품 단가 협상 여지", summary: "철스크랩 시세가 약세를 보이며 주철 부품의 원자재 비용 부담이 다소 줄었다.", items: ["ITM-1001", "ITM-1007"], materials: ["철스크랩"] },
  { date: "2026-08-20", title: "과급기 부품 리드타임 장기화, 노즐링 납기 6개월까지 늘어", summary: "과급기 핵심 부품의 생산 대기가 길어지며 노즐링 납기가 길어지는 사례가 늘었다.", items: ["ITM-1010"], materials: [] },
  { date: "2026-08-05", title: "구리·주석 강세로 청동 주물·베어링 메탈 가격 상승 압력", summary: "구리와 주석 시세가 함께 오르며 청동 주물 임펠러와 화이트메탈 베어링의 원가 상승 압력이 커졌다.", items: ["ITM-1008", "ITM-1005"], materials: ["구리", "주석"] },
  { date: "2026-07-22", title: "국내 단조 업계 설비 증설… 대형 스핀들·볼트 공급 여력 확대", summary: "단조 업체들의 설비 증설로 대형 단조품의 공급 여력이 늘어날 전망이다.", items: ["ITM-1003", "ITM-1006"], materials: [] },
  { date: "2026-07-08", title: "원/달러 1,400원대 지속, 외화 계약·수입 원자재 비용 증가", summary: "환율이 높은 수준을 유지하며 외화 계약 품목과 수입 원자재의 원화 비용이 늘고 있다.", items: ["ITM-1001"], materials: ["니켈", "몰리브덴", "주석"] },
].map((r) => ({ ...r, source: "SAMPLE 기사 (가상)", sourceUrl: null }));

const meta = {
  label: "SAMPLE · 시연용 가상 데이터",
  asOf: AS_OF,
  note: "업체명·품목·수치는 모두 가상이며 실제 회사 데이터가 아닙니다.",
  generatedBy: "scripts/generate-sample.mjs",
};

const write = (name, data) => writeFileSync(join(OUT, name), JSON.stringify(data, null, 2) + "\n");
write("meta.json", meta);
write("items.json", itemRows);
write("suppliers.json", supplierRows);
write("purchaseOrders.json", purchaseOrders);
write("contracts.json", contracts);
write("inventory.json", inventory);
write("bom.json", bom);
write("materialPrices.json", materialPrices);
write("fxRates.json", fxRates);
write("laborWages.json", laborWages);
write("competitorSupply.json", competitorSupply);
write("industryNews.json", industryNews);
console.log(`items ${itemRows.length}, suppliers ${supplierRows.length}, POs ${purchaseOrders.length}, contracts ${contracts.length}, inventory ${inventory.length}`);
console.log(`bom ${bom.length}, materialPrices ${materialPrices.length}, fxRates ${fxRates.length}, laborWages ${laborWages.length}, competitorSupply ${competitorSupply.length}, industryNews ${industryNews.length}`);
