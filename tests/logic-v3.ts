// v0.3 계산 로직 검사: npx tsx tests/logic-v3.ts [xlsx 저장 경로]
// 결제 예정일, 원자재 원화 환산·변동률, 임금 상승률, 요약 지표 건수, 부품 분류, xlsx 생성
import { writeFileSync } from "node:fs";
import { loadSample } from "../src/data/sampleData";
import { derive } from "../src/lib/metrics";
import { addDays, alertCount, buildPayments, monthEnd, parseTerms, payDateOf, statusOf } from "../src/lib/payments";
import { buildMaterialSeries, buildWageTree, jobsForProcess, toKrwPerKg } from "../src/lib/market";
import { KPIS } from "../src/lib/kpi";
import { itemsUnder, optionsAt, pathText } from "../src/lib/bom";
import { buildXlsx, colName, crc32, excelDate } from "../src/lib/xlsx";
import { resultSheets } from "../src/lib/exporters";
import { runAnalysis } from "../src/lib/analysis";
import { validateRows } from "../src/lib/validate";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const { data, meta } = loadSample();
const d = derive(data, meta.asOf);

// ── 결제 예정일 ──
const ok = (t: string) => {
  const p = parseTerms(t);
  return p.ok ? p : null;
};
check("월말 마감 60일: 8/14 입고 → 10/30", payDateOf("2026-08-14", ok("월말 마감 60일")!) === "2026-10-30");
check("월말 마감 익월 20일: 9/1 입고 → 10/20", payDateOf("2026-09-01", ok("월말 마감 익월 20일")!) === "2026-10-20");
check("월말 마감 익월 31일: 1/15 입고 → 2/28 (말일 보정)", payDateOf("2026-01-15", ok("월말 마감 익월 31일")!) === "2026-02-28");
check("입고 후 30일: 9/17 → 10/17", payDateOf("2026-09-17", ok("입고 후 30일")!) === "2026-10-17");
check("검수 후 45일 인식", parseTerms("검수 후 45일").ok);
check("선적 조건은 날짜를 추정하지 않음", !parseTerms("T/T 선적 후 30일").ok);
check("분할 결제는 해석 불가", !parseTerms("분할 결제 (선급 30% · 잔금 별도 협의)").ok);
check("결제조건 없음", !parseTerms("").ok);
check("월말 계산", monthEnd("2024-02-10") === "2024-02-29" && addDays("2026-12-30", 3) === "2027-01-02");
check("상태 구분: D-0 임박, D-7 임박, D-8 예정, D-30 예정, D-31 이후, D+3 지급 확인 필요, D+15 제외", statusOf(0) === "임박" && statusOf(7) === "임박" && statusOf(8) === "예정" && statusOf(30) === "예정" && statusOf(31) === "이후" && statusOf(-3) === "지급 확인 필요" && statusOf(-15) === null);
const pay = buildPayments(d.poViews, data.contracts, meta.asOf);
check("샘플 결제: 임박 5건", pay.summary["임박"].count === 5, String(pay.summary["임박"].count));
check("샘플 결제: 예정 10건", pay.summary["예정"].count === 10, String(pay.summary["예정"].count));
check("샘플 결제: 지급 확인 필요 1건", pay.summary["지급 확인 필요"].count === 1);
check("샘플 결제: 결제조건 확인 필요 3건", pay.summary["조건 확인 필요"].count === 3);
check("샘플 결제: 입고 대기 3건 (납기 지연 발주)", pay.summary["입고 대기"].count === d.poViews.filter((p) => p.status === "납기 지연").length);
const r59 = pay.rows.find((r) => r.poNo === "PO-2026-0059");
check("PO-2026-0059: 10/20 결제, D-5 임박", r59?.payDate === "2026-10-20" && r59?.dday === 5 && r59?.status === "임박", JSON.stringify(r59));
check("금액 = 수량 × 단가", pay.rows.every((r) => r.amount === null || r.amount === d.poViews.find((p) => p.poNo === r.poNo)!.qty * (d.poViews.find((p) => p.poNo === r.poNo)!.unitPrice ?? 0)));
check("통화별 합계 (환율로 합치지 않음)", Object.keys(pay.summary["조건 확인 필요"].amounts).includes("USD"));
check("알림 건수 = 임박 + 지급 확인 필요", alertCount(pay, []) === 6 && alertCount(pay, ["PO-2026-0059"]) === 5);
check("주별 그래프 12주", pay.weeks.length === 12 && pay.weeks[0].from === meta.asOf);

// ── 원자재 시세 ──
const fx = new Map([["2026-09|USD", 1400]]);
check("USD/톤 → 원/kg 환산", toKrwPerKg({ month: "2026-09", price: 10000, unit: "톤", currency: "USD" }, fx) === 14000);
check("원/kg 그대로", toKrwPerKg({ month: "2026-09", price: 520, unit: "kg", currency: "KRW" }, fx) === 520);
check("환율 없으면 환산하지 않음", toKrwPerKg({ month: "2026-08", price: 1, unit: "톤", currency: "USD" }, fx) === null);
const mats = buildMaterialSeries(data.materialPrices, data.fxRates);
check("원자재 7종, 24개월", mats.length === 7 && mats.every((m) => m.months.length === 24), mats.map((m) => m.material).join(","));
const ni = mats.find((m) => m.material === "니켈")!;
const niDom = data.materialPrices.filter((r) => r.material === "니켈" && r.market === "국내").sort((a, b) => a.month.localeCompare(b.month));
const yoy = Math.round((niDom[23].price / niDom[11].price - 1) * 1000) / 10;
check("니켈 국내 전년 대비 = (최근 ÷ 12개월 전 − 1)", ni.yoy.domestic === yoy, `${ni.yoy.domestic} / ${yoy}`);
check("모든 품목에 주요 소재가 있고 시세가 있음", data.items.every((i) => (i.materials ?? []).length > 0 && (i.materials ?? []).every((m) => mats.some((x) => x.material === m))));

// ── 인건비 ──
const wt = buildWageTree(data.laborWages);
check("직종 대분류 3개", wt.roots.length === 3, wt.roots.map((r) => r.name).join(" / "));
check("소분류 12개", wt.byMinor.size === 12);
const cast = wt.byMinor.get("주조원")!;
const castRows = data.laborWages.filter((r) => r.minor === "주조원").sort((a, b) => a.month.localeCompare(b.month));
check("주조원 전년 대비 상승률 계산", cast.yoy === Math.round((castRows[23].wage / castRows[11].wage - 1) * 1000) / 10);
check("공정 → 직종 연결 (단조·가공)", jobsForProcess("단조·가공").join(",") === "단조원,열처리 조작원,CNC 공작기계 조작원,연삭·정밀가공 조작원");

// ── 요약 지표 ──
const k = Object.fromEntries(KPIS.map((x) => [x.id, x.count(d)]));
check("요약 지표: 기준 미달(C·D) 2곳", k.gradeCD === 2, JSON.stringify(k));
check("요약 지표: 납기 지연 3건", k.overdue === 3);
check("요약 지표: 단가 상승 4건", k.priceUp === 4);
check("요약 지표: 재고 미달 3품목", k.belowSafety === 3);

// ── 부품 분류 ──
check("BOM 18행 (엔진 2종)", data.bom.length === 18);
check("엔진 목록", optionsAt(d.bomIndex, [], 0).map((o) => o.value).join(",") === "SAMPLE 엔진 X형,SAMPLE 엔진 Y형");
check("배기밸브 어셈블리 → ITM-1003", [...itemsUnder(d.bomIndex, ["SAMPLE 엔진 X형", "실린더부 (라이너·커버·배기밸브)", "배기밸브 어셈블리"])].join(",") === "ITM-1003");
check("한 엔진에만 쓰이는 품목", !itemsUnder(d.bomIndex, ["SAMPLE 엔진 Y형"]).has("ITM-1008") && itemsUnder(d.bomIndex, ["SAMPLE 엔진 X형"]).has("ITM-1008"));
check("분류 경로 문구", (pathText(d.bomIndex, "ITM-1001") ?? "").includes("엔진 X형·엔진 Y형 › 실린더부"));

// ── 업로드 검사 (새 데이터 종류) ──
const v = validateRows("materialPrices", [{ 기준월: "2026.10", 원자재: "니켈", 시장: "국내", 가격: "27,000", 단위: "kg", 통화: "KRW" }, { 기준월: "2026-13", 원자재: "니켈", 시장: "국내", 가격: 1 }]);
check("원자재 업로드: 월 형식 변환·오류", v.rows.length === 1 && (v.rows[0] as { month: string }).month === "2026-10" && v.errors.length === 1);
const h = validateRows("suppliers", [{ 업체ID: "X1", 협력사명: "테스트", 평가이력: "2025H1:B:84:납기 개선;2025 하반기:A:86" }]);
const hist = (h.rows[0] as { evalHistory: { half: number; reason?: string | null }[] }).evalHistory;
check("평가 이력 반기·사유 형식", hist.length === 2 && hist[0].half === 1 && hist[0].reason === "납기 개선" && hist[1].half === 2);
const dup = validateRows("bom", [{ 엔진모델: "E", 대부품: "a", 중부품: "b", 소부품: "c", 품목코드: "ITM-1001" }, { 엔진모델: "E", 대부품: "a", 중부품: "b", 소부품: "d", 품목코드: "ITM-1001" }]);
check("여러 열 기본 키 중복 검사", dup.errors.some((e) => e.message.includes("중복")));

// ── xlsx ──
check("CRC32", crc32(new TextEncoder().encode("123456789")) === 0xcbf43926);
check("열 이름 A·Z·AA", colName(0) === "A" && colName(25) === "Z" && colName(26) === "AA");
check("엑셀 날짜 일련번호", excelDate("2026-10-15") === 46310);
const res = runAnalysis({ kind: "item_candidates", itemCode: "ITM-1001", priority: "balanced" }, data, d, meta, "실린더 라이너 후보 업체 비교");
const bytes = buildXlsx(resultSheets(res, res.title), res.title);
check("xlsx zip 서명", bytes[0] === 0x50 && bytes[1] === 0x4b && bytes.length > 4000, `${bytes.length} bytes`);
if (process.argv[2]) writeFileSync(process.argv[2], bytes);

console.log(`\n${pass}/${pass + fail} 통과`);
process.exit(fail ? 1 : 0);
