// 분석 로직 스모크 테스트: npx tsx tests/logic-smoke.ts
import { loadSample } from "../src/data/sampleData";
import { derive } from "../src/lib/metrics";
import { answer } from "../src/ai/agent";

const { data, meta } = loadSample();
const d = derive(data, meta.asOf);
console.log("평가:", [...d.evaluations.values()].map((e) => `${d.suppliersById.get(e.supplierId)!.name} ${e.grade} ${e.total}`).join(" | "));
const ctx: any = { data, derived: d, meta, selection: { supplierId: "SUP-001", itemCode: null }, lastResult: null, pending: null };
const qs = [
  "해당 품목의 과거 거래 업체를 등급, 납기 실적, 최근 단가와 함께 보여주어 품목별 후보 업체 표시해줘.",
];
(async () => {
  let r: any = await answer(qs[0], ctx, null);
  console.log("\n[Q1]", r.type, r.text);
  // 품목 선택으로 답함
  ctx.pending = r.pending;
  r = await answer("실린더 라이너", ctx, null);
  console.log("[Q1-answer]", r.type, r.text);
  ctx.pending = null; ctx.lastResult = r.result;
  console.table(r.result.rows.map((x: any) => ({ 업체: x.label, 등급: x.values.grade, 납기: x.values.onTimeRate, 단가: x.values.price, 건수: x.values.trades, 점수: x.values.score, 순위: x.rank, 제외: x.excludedReason ?? "" })));
  r = await answer("여기서 단가보다 납기를 우선하면 어떤 업체가 적합해?", ctx, null);
  console.log("[Q2]", r.type, r.text);
  for (const q of ["납기 준수율이 낮은 협력사를 찾아줘.", "최근 단가가 상승한 품목을 보여줘.", "A등급 협력사의 품질 실적을 정리해 줘.", "업체 D 평가 근거 알려줘", "업체 A랑 업체 C 비교해줘", "재고 부족한 품목 있어?", "노즐 후보 업체 비교", "터보차저 노즐링 거래 업체", "ITM-9999 후보 업체", "오늘 날씨 어때", "최근 6개월 납기 준수율 85% 미만 업체"]) {
    const x: any = await answer(q, { ...ctx, lastResult: null }, null);
    console.log(`\n[${q}] → ${x.type} ${x.result?.kind ?? ""} rows=${x.result?.rows.length ?? "-"}\n  ${x.text.join("\n  ")}`);
  }
})();
