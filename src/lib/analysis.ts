// 분석 계층 ③: 질문 의도별 분석 — 모든 수치는 여기서 코드로 계산한다 (AI는 수치를 만들지 않는다)
import type { DataMeta, DataSet, Grade } from "../data/types";
import type { AnalysisParams, AnalysisResult, ChartSpec, IntentKind, PriorityMode, ResultColumn, ResultRow, SourceRef, TemplateId } from "./analysisTypes";
import { EVAL_CONFIG, qualityScore } from "./evaluation";
import { addMonths, fmtMoney, fmtNum, fmtPct, fmtSignedPct, josa, quarterOf, quarterSortKey, round } from "./format";
import { deliveryByQuarter, deliveryStats, priceByQuarter, type ContractView, type Derived, type POView } from "./metrics";

export const KIND_LABEL: Record<IntentKind, string> = {
  item_candidates: "품목별 후보 업체 비교",
  low_delivery: "납기 준수율 저조 협력사",
  price_increase: "단가 상승 품목",
  grade_quality: "등급별 품질 실적",
  supplier_profile: "협력사 평가 근거",
  supplier_compare: "협력사 비교",
  stock_risk: "재고·공급 위험 품목",
};

export const PRIORITY: Record<PriorityMode, { label: string; delivery: number; price: number; quality: number }> = {
  balanced: { label: "균형", delivery: 35, price: 35, quality: 30 },
  delivery: { label: "납기 우선", delivery: 60, price: 15, quality: 25 },
  price: { label: "단가 우선", delivery: 20, price: 60, quality: 20 },
  quality: { label: "품질 우선", delivery: 25, price: 15, quality: 60 },
};

export const weightText = (p: PriorityMode) => {
  const w = PRIORITY[p];
  return `납기 ${w.delivery} · 단가 ${w.price} · 품질 ${w.quality}`;
};

export class AnalysisError extends Error {}

interface Ctx {
  data: DataSet;
  d: Derived;
  meta: DataMeta;
  question: string;
}

let seq = 0;
const newId = () => `r${Date.now().toString(36)}${(seq++).toString(36)}`;

function periodOf(ctx: Ctx, months?: number | null) {
  const from = months ? addMonths(ctx.meta.asOf, -months) : ctx.d.windowFrom;
  const label = months ? `최근 ${months}개월 (${from} ~ ${ctx.meta.asOf})` : `평가 기간 ${EVAL_CONFIG.windowMonths}개월 (${from} ~ ${ctx.meta.asOf})`;
  return { from, label };
}

function base(ctx: Ctx, params: AnalysisParams, partial: Partial<AnalysisResult>): AnalysisResult {
  return {
    id: newId(),
    params,
    kind: params.kind,
    kindLabel: KIND_LABEL[params.kind],
    title: KIND_LABEL[params.kind],
    question: ctx.question,
    purpose: "",
    createdAt: new Date().toISOString(),
    dataVersion: ctx.meta.version,
    dataId: ctx.meta.dataId,
    asOf: ctx.meta.asOf,
    dataLabel: ctx.meta.label,
    scope: [],
    columns: [],
    rows: [],
    cardMetrics: [],
    highlights: [],
    summary: [],
    risks: [],
    reviewPoints: [],
    basis: [],
    notes: [],
    sources: [],
    charts: [],
    recommended: "table",
    templates: ["table", "chart", "cards", "report"],
    templateHints: {},
    ...partial,
  };
}

const uniq = <T,>(xs: T[]) => Array.from(new Set(xs));
const normalize = (v: number, min: number, max: number, higherBetter: boolean) => {
  if (max === min) return 1;
  return higherBetter ? (v - min) / (max - min) : (max - v) / (max - min);
};

function latestContract(cs: ContractView[]) {
  return [...cs].sort((a, b) => String(b.startDate || "").localeCompare(String(a.startDate || "")))[0];
}

function quarterAxis(pos: POView[]) {
  const keys = new Map<string, string>();
  for (const p of pos) keys.set(quarterSortKey(p.orderDate), quarterOf(p.orderDate));
  const sorted = [...keys].sort((a, b) => a[0].localeCompare(b[0]));
  return { keys: sorted.map((k) => k[0]), labels: sorted.map((k) => k[1]) };
}

// ─────────────────────────────── 품목별 후보 업체
function itemCandidates(ctx: Ctx, params: AnalysisParams): AnalysisResult {
  const { d } = ctx;
  const item = d.itemsByCode.get(params.itemCode || "");
  if (!item) throw new AnalysisError(`품목코드 ${params.itemCode}를 데이터에서 찾지 못했습니다.`);
  const priority = params.priority || "balanced";
  const w = PRIORITY[priority];
  const period = periodOf(ctx, params.periodMonths);
  const pos = d.poViews.filter((p) => p.itemCode === item.itemCode && p.orderDate >= period.from && p.status !== "취소");
  const supplierIds = uniq(pos.map((p) => p.supplierId));
  const registeredOnly = ctx.data.suppliers.filter((s) => s.items.includes(item.itemCode) && !supplierIds.includes(s.supplierId));

  const raw = supplierIds.map((sid) => {
    const sup = d.suppliersById.get(sid);
    const mine = pos.filter((p) => p.supplierId === sid);
    const st = deliveryStats(mine);
    const contract = latestContract(d.contractViews.filter((c) => c.itemCode === item.itemCode && c.supplierId === sid));
    const lastPO = [...mine].filter((p) => p.unitPrice != null).sort((a, b) => b.orderDate.localeCompare(a.orderDate))[0];
    const price = contract ? contract.unitPrice : lastPO?.unitPrice ?? null;
    const currency = contract ? contract.currency : lastPO?.currency ?? "KRW";
    const ev = d.evaluations.get(sid);
    const q = sup ? qualityScore(sup.qualityScore, sup.defectRate) : null;
    return { sid, sup, st, contract, price, currency, ev, q, priceSource: contract ? `계약 ${contract.contractId}` : lastPO ? `발주 ${lastPO.poNo}` : "없음" };
  });
  if (!raw.length) {
    return base(ctx, params, {
      title: `${item.name} 후보 업체`,
      empty: `${period.label} 동안 ${item.name}(${item.itemCode})의 발주 이력이 없습니다.`,
      scope: [{ label: "품목", value: `${item.name} · ${item.itemCode}` }],
    });
  }

  // 비교 기준 조건: 가장 많은 업체가 속한 (통화·인도조건·규격) 그룹
  const keyOf = (r: (typeof raw)[number]) => [r.currency, r.contract?.deliveryTerms || "", r.contract?.spec || item.spec || ""].join("|");
  const counts = new Map<string, number>();
  raw.forEach((r) => counts.set(keyOf(r), (counts.get(keyOf(r)) || 0) + 1));
  const baseKey = [...counts].sort((a, b) => b[1] - a[1] || (a[0].startsWith("KRW") ? -1 : 1))[0][0];
  const [baseCur, baseTerms, baseSpec] = baseKey.split("|");
  const comparable = raw.filter((r) => keyOf(r) === baseKey && r.price !== null);

  const rates = comparable.map((r) => r.st.rate ?? 0);
  const prices = comparable.map((r) => r.price as number);
  const qs = comparable.map((r) => r.q ?? 0);
  const scoreOf = (r: (typeof raw)[number]) =>
    round(
      (w.delivery * normalize(r.st.rate ?? 0, Math.min(...rates), Math.max(...rates), true) +
        w.price * normalize(r.price as number, Math.min(...prices), Math.max(...prices), false) +
        w.quality * normalize(r.q ?? 0, Math.min(...qs), Math.max(...qs), true)) /
        1,
      1,
    );
  const scored = comparable.map((r) => ({ sid: r.sid, score: scoreOf(r) })).sort((a, b) => b.score - a.score);
  const rankOf = new Map(scored.map((s, i) => [s.sid, i + 1]));
  const scoreMap = new Map(scored.map((s) => [s.sid, s.score]));

  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxRate = rates.length ? Math.max(...rates) : null;
  const maxQ = qs.length ? Math.max(...qs) : null;

  const rows: ResultRow[] = raw.map((r) => {
    const name = r.sup?.name ?? r.sid;
    const diffs: string[] = [];
    if (r.currency !== baseCur) diffs.push(`통화 ${r.currency}`);
    if ((r.contract?.deliveryTerms || "") !== baseTerms) diffs.push(`인도조건 ${r.contract?.deliveryTerms || "미기재"}`);
    if ((r.contract?.spec || item.spec || "") !== baseSpec) diffs.push("규격 상이");
    if (r.price === null) diffs.push("단가 없음");
    const isComparable = !diffs.length;
    const strengths: string[] = [];
    const risks: string[] = [];
    if (isComparable && r.price === minPrice && comparable.length > 1) strengths.push(`동일 조건 최저 단가 (${fmtMoney(r.price, r.currency)})`);
    if (r.st.rate !== null && r.st.rate === maxRate && comparable.length > 1) strengths.push(`해당 품목 납기 준수율 최고 (${fmtPct(r.st.rate)})`);
    if (r.q !== null && r.q === maxQ && comparable.length > 1) strengths.push(`품질 점수 최고 (${fmtNum(r.q)}점)`);
    if (r.ev?.grade === "A") strengths.push("평가등급 A");
    if (r.st.rate !== null && r.st.rate < EVAL_CONFIG.lowDeliveryThreshold) risks.push(`납기 준수율 ${fmtPct(r.st.rate)} — 관리 기준 ${EVAL_CONFIG.lowDeliveryThreshold}% 미만`);
    if (r.st.overdueOpen) risks.push(`납기 경과 미입고 발주 ${r.st.overdueOpen}건`);
    if (r.contract?.changeRate != null && r.contract.changeRate >= EVAL_CONFIG.priceIncreaseThreshold) risks.push(`최근 계약 단가 ${fmtSignedPct(r.contract.changeRate)} 인상`);
    if (r.sup?.defectRate != null && r.sup.defectRate >= 1.5) risks.push(`불량률 ${fmtNum(r.sup.defectRate)}%`);
    if (r.st.evaluated < EVAL_CONFIG.minSamples) risks.push(`마감 발주 ${r.st.evaluated}건 — 표본이 적어 참고용`);
    if (!isComparable) risks.push(`비교 조건 상이(${diffs.join(", ")}) — 단가 순위에서 제외`);
    if (r.ev?.missing.length) risks.push(`평가 데이터 누락: ${r.ev.missing.map((m) => m.split(":")[0]).join(", ")}`);
    return {
      id: r.sid,
      label: name,
      sub: r.sid,
      supplierId: r.sid,
      itemCode: item.itemCode,
      currency: r.currency,
      rank: rankOf.get(r.sid) ?? null,
      excludedReason: isComparable ? undefined : diffs.join(", "),
      values: {
        grade: r.ev?.grade ?? null,
        trades: r.st.poCount,
        onTimeRate: r.st.rate,
        late: r.st.late,
        price: r.price,
        priceChange: r.contract?.changeRate ?? null,
        lastTrade: r.st.lastTradeDate,
        quality: r.q,
        score: scoreMap.get(r.sid) ?? null,
        condition: isComparable ? "기준 조건" : diffs.join(", "),
      },
      strengths,
      risks,
      evidence: [
        `발주 ${r.st.poCount}건 (마감 ${r.st.evaluated}건 중 기한 내 ${r.st.onTime}건)`,
        `단가 출처: ${r.priceSource}${r.contract ? ` · ${r.contract.deliveryTerms ?? ""}` : ""}`,
        `평가등급: ${r.ev?.grade ?? "–"} (${fmtNum(r.ev?.total ?? null)}점, ${EVAL_CONFIG.name})`,
      ],
    };
  });
  rows.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));

  const columns: ResultColumn[] = [
    { key: "grade", label: "평가등급", kind: "grade", primary: true },
    { key: "onTimeRate", label: "납기 준수율", kind: "percent", higherIsBetter: true, primary: true },
    { key: "price", label: "최근 단가", kind: "money", higherIsBetter: false, primary: true },
    { key: "trades", label: "거래 건수", kind: "int" },
    { key: "lastTrade", label: "최근 거래일", kind: "date" },
    { key: "quality", label: "품질 점수", kind: "number", higherIsBetter: true },
    { key: "priceChange", label: "단가 변동", kind: "signedPercent", higherIsBetter: false },
    { key: "late", label: "지연 건수", kind: "int", higherIsBetter: false },
    { key: "score", label: "검토 점수", kind: "number", higherIsBetter: true },
    { key: "condition", label: "비교 조건", kind: "text" },
  ];

  const cheapest = comparable.length ? rows.find((r) => r.values.price === minPrice && !r.excludedReason) : undefined;
  const fastest = rows.filter((r) => !r.excludedReason).sort((a, b) => Number(b.values.onTimeRate ?? 0) - Number(a.values.onTimeRate ?? 0))[0];
  const best = rows.find((r) => r.rank === 1);
  const excluded = rows.filter((r) => r.excludedReason);
  const pri = PRIORITY[priority];
  const termsLabel = `${baseCur}${baseTerms ? ` · ${baseTerms}` : ""}`;

  const summary = [
    `${item.name}(${item.itemCode})의 과거 거래 업체 ${rows.length}곳, 발주 ${pos.length}건을 비교했습니다.`,
    comparable.length > 1
      ? `동일 조건(${termsLabel}) ${comparable.length}곳 중 단가는 ${cheapest?.label}(${fmtMoney(minPrice, baseCur)})${josa(cheapest?.label ?? "", "이/가")} 가장 낮고, 납기 준수율은 ${fastest?.label}(${fmtPct(Number(fastest?.values.onTimeRate))})${josa(fastest?.label ?? "", "이/가")} 가장 높습니다.`
      : `동일 조건으로 비교할 수 있는 업체가 ${comparable.length}곳이라 상대 비교는 제한적입니다.`,
    best ? `${pri.label} 기준(${weightText(priority)}) 검토 순서 1위는 ${best.label}입니다. 최종 선정은 담당자가 검토 후 확정합니다.` : "",
  ].filter(Boolean);
  for (const r of excluded) summary.push(`단가 순위 제외: ${r.label} — 비교 조건이 다릅니다(${r.excludedReason}).`);

  const risks = rows.flatMap((r) => r.risks.filter((x) => !x.startsWith("평가 데이터")).slice(0, 2).map((x) => `${r.label}: ${x}`));
  const reviewPoints = [
    ...rows.filter((r) => r.values.priceChange != null && Number(r.values.priceChange) >= EVAL_CONFIG.priceIncreaseThreshold).map((r) => `${r.label}의 단가 인상(${fmtSignedPct(Number(r.values.priceChange))}) 사유와 다음 계약 조건을 확인하세요.`),
    ...excluded.map((r) => `${r.label} 단가는 환율·물류비·관세를 반영한 도착가로 환산해야 같은 조건에서 비교할 수 있습니다.`),
    ...rows.filter((r) => r.risks.some((x) => x.includes("미입고"))).map((r) => `${r.label}의 납기 경과 미입고 발주 처리 계획을 확인하세요.`),
    item.criticality === "상" ? `${item.name}${josa(item.name, "은/는")} 중요도 '상' 품목이므로 단일 업체 집중 여부를 함께 검토하세요.` : "",
    registeredOnly.length ? `공급 가능 업체로 등록됐지만 거래 이력이 없는 업체: ${registeredOnly.map((s) => s.name).join(", ")}` : "",
  ].filter(Boolean);

  const supNames = raw.map((r) => r.sup?.name ?? r.sid);
  const qa = quarterAxis(pos.filter((p) => p.currency === baseCur));
  const charts: ChartSpec[] = [
    {
      id: "ontime",
      title: "해당 품목 납기 준수율",
      type: "bar",
      unit: "%",
      yLabel: "납기 준수율 (%)",
      categories: supNames,
      series: [{ key: "rate", label: "납기 준수율", values: raw.map((r) => r.st.rate) }],
      refLine: { value: EVAL_CONFIG.lowDeliveryThreshold, label: `관리 기준 ${EVAL_CONFIG.lowDeliveryThreshold}% (예시)` },
      statusOf: raw.map((r) => (r.st.rate !== null && r.st.rate < EVAL_CONFIG.lowDeliveryThreshold ? "critical" : null)),
      statusLabel: "관리 기준 미달",
      digits: 1,
    },
    {
      id: "price",
      title: `최근 단가 비교 (동일 조건 · ${baseCur})`,
      type: "bar",
      unit: baseCur === "KRW" ? "원" : baseCur,
      yLabel: `단가 (${baseCur === "KRW" ? "원" : baseCur})`,
      categories: comparable.map((r) => r.sup?.name ?? r.sid),
      series: [{ key: "price", label: "최근 단가", values: comparable.map((r) => r.price) }],
      caption: excluded.length ? `비교 조건이 달라 제외: ${excluded.map((r) => r.label).join(", ")}` : undefined,
      digits: 0,
    },
    {
      id: "trend",
      title: `분기별 평균 발주 단가 (${baseCur})`,
      type: "line",
      unit: baseCur === "KRW" ? "원" : baseCur,
      yLabel: `단가 (${baseCur === "KRW" ? "원" : baseCur})`,
      xLabel: "발주 분기",
      categories: qa.labels,
      series: comparable.map((r) => {
        const m = priceByQuarter(pos.filter((p) => p.supplierId === r.sid));
        return { key: r.sid, label: r.sup?.name ?? r.sid, values: qa.keys.map((k) => m.get(k)?.value ?? null) };
      }),
      digits: 0,
    },
    {
      id: "score",
      title: `검토 점수 (${weightText(priority)})`,
      type: "bar",
      unit: "점",
      yLabel: "검토 점수 (0~100)",
      categories: scored.map((s) => d.suppliersById.get(s.sid)?.name ?? s.sid),
      series: [{ key: "score", label: "검토 점수", values: scored.map((s) => s.score) }],
      caption: "비교 업체 간 상대값이므로 업체를 바꾸면 점수도 달라집니다",
      digits: 1,
    },
  ];

  const sources: SourceRef[] = [
    { table: "purchaseOrders", label: "구매조달 발주", ids: pos.map((p) => p.poNo) },
    { table: "contracts", label: "원가-계약", ids: raw.map((r) => r.contract?.contractId).filter(Boolean) as string[] },
    { table: "suppliers", label: "협력업체", ids: supplierIds },
  ];

  return base(ctx, params, {
    title: `${item.name} 후보 업체 비교${priority !== "balanced" ? ` · ${pri.label}` : ""}`,
    purpose: `${item.name}(${item.itemCode}) 발주 시 검토할 후보 업체를 과거 거래 실적으로 비교합니다.`,
    scope: [
      { label: "품목", value: `${item.name} · ${item.itemCode}` },
      { label: "규격", value: item.spec || "–" },
      { label: "기간", value: period.label },
      { label: "우선순위", value: `${pri.label} (${weightText(priority)})` },
    ],
    columns,
    rows,
    rankLabel: "검토 순서",
    cardMetrics: ["onTimeRate", "price", "trades", "quality"],
    highlights: [
      cheapest ? { label: "단가 경쟁력", value: `${cheapest.label} · ${fmtMoney(minPrice, baseCur)}`, rowId: cheapest.id } : null,
      fastest ? { label: "납기 실적", value: `${fastest.label} · ${fmtPct(Number(fastest.values.onTimeRate))}`, rowId: fastest.id } : null,
      best ? { label: `검토 순서 1위 (${pri.label})`, value: `${best.label} · ${fmtNum(Number(best.values.score))}점`, rowId: best.id } : null,
    ].filter(Boolean) as AnalysisResult["highlights"],
    summary,
    risks,
    reviewPoints,
    basis: [
      "납기 준수율 = 기한 내 입고 건 ÷ 마감된 발주 건 (납기가 지났는데 입고되지 않은 건은 지연)",
      "최근 단가 = 유효 계약 단가, 계약이 없으면 가장 최근 발주 단가",
      `단가 비교는 같은 품목·규격·통화·인도조건(${termsLabel})끼리만 합니다`,
      `검토 점수 = 비교 업체 간 상대값(0~100)에 가중치(${weightText(priority)})를 적용한 값`,
      `평가등급 = ${EVAL_CONFIG.name}`,
    ],
    notes: registeredOnly.length ? [`거래 이력 없는 공급 가능 등록 업체 ${registeredOnly.length}곳은 비교에서 제외`] : [],
    sources,
    charts,
    recommended: "table",
    templates: ["table", "chart", "cards", "report"],
    templateHints: {
      table: "등급, 납기율, 단가를 한눈에 비교",
      chart: "납기 준수율과 단가를 시각적으로 비교",
      cards: "업체별 장단점과 검토 순위 표시",
      report: "근거와 검토 의견까지 포함",
    },
  });
}

// ─────────────────────────────── 납기 준수율 저조
function lowDelivery(ctx: Ctx, params: AnalysisParams): AnalysisResult {
  const { d } = ctx;
  const threshold = params.threshold ?? EVAL_CONFIG.lowDeliveryThreshold;
  const period = periodOf(ctx, params.periodMonths);
  const pos = d.poViews.filter((p) => p.orderDate >= period.from && p.status !== "취소");
  const all = ctx.data.suppliers.map((s) => {
    const mine = pos.filter((p) => p.supplierId === s.supplierId);
    const st = deliveryStats(mine);
    const lateByItem = new Map<string, number>();
    mine.filter((p) => p.evaluated && !p.onTime).forEach((p) => lateByItem.set(p.itemName, (lateByItem.get(p.itemName) || 0) + 1));
    const topItem = [...lateByItem].sort((a, b) => b[1] - a[1])[0];
    return { s, st, mine, topItem };
  });
  const flagged = all.filter((x) => x.st.rate !== null && x.st.rate < threshold).sort((a, b) => (a.st.rate as number) - (b.st.rate as number));
  const rows: ResultRow[] = flagged.map((x, i) => ({
    id: x.s.supplierId,
    label: x.s.name,
    sub: x.s.supplierId,
    supplierId: x.s.supplierId,
    rank: i + 1,
    values: {
      grade: d.evaluations.get(x.s.supplierId)?.grade ?? null,
      evaluated: x.st.evaluated,
      late: x.st.late,
      onTimeRate: x.st.rate,
      avgDelay: x.st.avgDelay,
      overdue: x.st.overdueOpen,
      topItem: x.topItem ? `${x.topItem[0]} (${x.topItem[1]}건)` : "–",
    },
    strengths: [],
    risks: [
      `납기 준수율 ${fmtPct(x.st.rate)} (기준 ${threshold}%)`,
      x.st.avgDelay ? `지연 시 평균 ${fmtNum(x.st.avgDelay)}일 늦음` : "",
      x.st.overdueOpen ? `납기 경과 미입고 ${x.st.overdueOpen}건` : "",
      x.st.evaluated < EVAL_CONFIG.minSamples ? `마감 발주 ${x.st.evaluated}건 — 표본이 적음` : "",
    ].filter(Boolean),
    evidence: [`마감 발주 ${x.st.evaluated}건 중 지연 ${x.st.late}건`, x.topItem ? `지연이 많은 품목: ${x.topItem[0]}` : ""].filter(Boolean),
  }));
  const charted = all.filter((x) => x.st.rate !== null).sort((a, b) => (a.st.rate as number) - (b.st.rate as number));
  const qa = (() => {
    const keys = new Map<string, string>();
    flagged.forEach((x) => x.mine.filter((p) => p.evaluated).forEach((p) => keys.set(quarterSortKey(p.dueDate), quarterOf(p.dueDate))));
    const s = [...keys].sort((a, b) => a[0].localeCompare(b[0]));
    return { keys: s.map((k) => k[0]), labels: s.map((k) => k[1]) };
  })();
  const res = base(ctx, params, {
    title: `납기 준수율 ${threshold}% 미만 협력사`,
    purpose: `납기 준수율이 관리 기준(${threshold}%)보다 낮은 협력사를 찾아 관리 우선순위를 정합니다.`,
    scope: [
      { label: "기준", value: `납기 준수율 ${threshold}% 미만${params.threshold ? "" : " (예시 기준)"}` },
      { label: "기간", value: period.label },
      { label: "대상", value: `협력사 ${all.filter((x) => x.st.evaluated).length}곳` },
    ],
    columns: [
      { key: "onTimeRate", label: "납기 준수율", kind: "percent", higherIsBetter: true, primary: true },
      { key: "late", label: "지연 건수", kind: "int", higherIsBetter: false, primary: true },
      { key: "evaluated", label: "마감 발주", kind: "int", primary: true },
      { key: "grade", label: "평가등급", kind: "grade", primary: true },
      { key: "avgDelay", label: "평균 지연일", kind: "number", higherIsBetter: false },
      { key: "overdue", label: "납기 경과 미입고", kind: "int", higherIsBetter: false },
      { key: "topItem", label: "지연 많은 품목", kind: "text" },
    ],
    rows,
    rankLabel: "낮은 순",
    cardMetrics: ["onTimeRate", "late", "avgDelay", "overdue"],
    highlights: rows.length
      ? [
          { label: "가장 낮은 업체", value: `${rows[0].label} · ${fmtPct(Number(rows[0].values.onTimeRate))}`, rowId: rows[0].id },
          { label: "기준 미달 업체 수", value: `${rows.length}곳` },
        ]
      : [],
    summary: rows.length
      ? [
          `${period.label} 기준 납기 준수율이 ${threshold}% 미만인 협력사는 ${rows.length}곳입니다.`,
          `가장 낮은 곳은 ${rows[0].label}(${fmtPct(Number(rows[0].values.onTimeRate))}, 지연 ${rows[0].values.late}건)입니다.`,
          rows.some((r) => Number(r.values.overdue) > 0) ? `납기가 지났는데 아직 입고되지 않은 발주가 ${rows.reduce((a, r) => a + Number(r.values.overdue || 0), 0)}건 있습니다.` : "",
        ].filter(Boolean)
      : [],
    risks: rows.flatMap((r) => r.risks.slice(0, 2).map((x) => `${r.label}: ${x}`)),
    reviewPoints: [
      ...rows.filter((r) => Number(r.values.overdue) > 0).map((r) => `${r.label}의 미입고 발주 입고 일정을 확인하고 생산 일정 영향 여부를 공유하세요.`),
      rows.length ? "지연이 반복되는 품목은 발주 리드타임을 늘리거나 대체 업체를 검토하세요." : "",
      rows.length ? "지연 원인(업체 사정·사양 변경·당사 요청 변경)은 데이터에 없으므로 담당자 확인이 필요합니다." : "",
    ].filter(Boolean),
    basis: [
      "납기 준수율 = 기한 내 입고 건 ÷ 마감된 발주 건",
      "납기가 지났지만 입고되지 않은 발주는 지연으로 계산",
      "진행 중(납기 전) 발주와 취소 발주는 제외",
      params.threshold ? `관리 기준 ${threshold}%는 질문에서 지정` : `관리 기준 ${threshold}%는 ${EVAL_CONFIG.name}의 예시값`,
    ],
    sources: [
      { table: "purchaseOrders", label: "구매조달 발주", ids: flagged.flatMap((x) => x.mine.map((p) => p.poNo)) },
      { table: "suppliers", label: "협력업체", ids: flagged.map((x) => x.s.supplierId) },
    ],
    charts: [
      {
        id: "ontime-all",
        title: "협력사별 납기 준수율",
        type: "hbar",
        unit: "%",
        yLabel: "납기 준수율 (%)",
        categories: charted.map((x) => x.s.name),
        series: [{ key: "rate", label: "납기 준수율", values: charted.map((x) => x.st.rate) }],
        refLine: { value: threshold, label: `기준 ${threshold}%` },
        statusOf: charted.map((x) => ((x.st.rate as number) < threshold ? "critical" : null)),
        statusLabel: "기준 미달",
        digits: 1,
      },
      {
        id: "ontime-q",
        title: "기준 미달 업체의 분기별 납기 준수율",
        type: "line",
        unit: "%",
        yLabel: "납기 준수율 (%)",
        xLabel: "납기 분기",
        categories: qa.labels,
        series: flagged.slice(0, 4).map((x) => {
          const m = deliveryByQuarter(x.mine);
          return { key: x.s.supplierId, label: x.s.name, values: qa.keys.map((k) => m.get(k)?.value ?? null) };
        }),
        digits: 0,
      },
    ],
    recommended: "chart",
    templates: ["chart", "table", "cards", "report"],
    templateHints: {
      chart: "전체 협력사 납기 준수율과 기준선",
      table: "지연 건수·평균 지연일까지 비교",
      cards: "업체별 위험 요소 정리",
      report: "관리 우선순위와 검토 의견",
    },
  });
  if (!rows.length) res.empty = `${period.label} 동안 납기 준수율이 ${threshold}% 미만인 협력사가 없습니다.`;
  return res;
}

// ─────────────────────────────── 단가 상승 품목
function priceIncrease(ctx: Ctx, params: AnalysisParams): AnalysisResult {
  const { d } = ctx;
  const threshold = params.threshold ?? EVAL_CONFIG.priceIncreaseThreshold;
  const list = d.contractViews
    .filter((c) => c.changeRate !== null && (c.changeRate as number) >= threshold)
    .filter((c) => !params.itemCode || c.itemCode === params.itemCode)
    .sort((a, b) => (b.changeRate as number) - (a.changeRate as number));
  const peerAvg = (c: ContractView) => {
    const peers = d.contractViews.filter((x) => x.itemCode === c.itemCode && x.supplierId !== c.supplierId && x.changeRate !== null);
    return peers.length ? round(peers.reduce((a, x) => a + (x.changeRate as number), 0) / peers.length, 1) : null;
  };
  const rows: ResultRow[] = list.map((c, i) => {
    const peer = peerAvg(c);
    return {
      id: c.contractId,
      label: `${c.itemName} · ${c.supplierName}`,
      sub: `${c.itemCode} · ${c.contractId}`,
      supplierId: c.supplierId,
      itemCode: c.itemCode,
      currency: c.currency,
      rank: i + 1,
      values: {
        prev: c.prevUnitPrice ?? null,
        price: c.unitPrice,
        changeRate: c.changeRate,
        peer: peer,
        currency: c.currency,
        endDate: c.endDate ?? null,
      },
      strengths: [],
      risks: [
        `직전 계약 대비 ${fmtSignedPct(c.changeRate)}`,
        peer !== null ? `같은 품목 다른 업체 평균 변동 ${fmtSignedPct(peer)}` : "같은 품목을 공급하는 다른 업체 계약이 없음",
        c.expiresInDays !== null && c.expiresInDays <= 60 ? `계약 종료까지 ${c.expiresInDays}일` : "",
      ].filter(Boolean),
      evidence: [`계약 ${c.contractId} (${c.startDate ?? "–"} ~ ${c.endDate ?? "–"})`, `${c.deliveryTerms ?? ""} · ${c.paymentTerms ?? ""}`],
    };
  });
  const pairsPos = list.slice(0, 4).map((c) => ({ c, pos: d.poViews.filter((p) => p.itemCode === c.itemCode && p.supplierId === c.supplierId && p.status !== "취소") }));
  const qa = quarterAxis(pairsPos.flatMap((x) => x.pos));
  const res = base(ctx, params, {
    title: `단가 ${threshold}% 이상 상승 품목`,
    purpose: `직전 계약보다 단가가 ${threshold}% 이상 오른 품목·업체를 찾아 협상과 원가 검토에 활용합니다.`,
    scope: [
      { label: "기준", value: `직전 계약 대비 +${threshold}% 이상${params.threshold ? "" : " (예시 기준)"}` },
      { label: "대상", value: `계약 ${d.contractViews.length}건` },
      { label: "기준일", value: ctx.meta.asOf },
    ],
    columns: [
      { key: "changeRate", label: "변동률", kind: "signedPercent", higherIsBetter: false, primary: true },
      { key: "price", label: "최근 단가", kind: "money", primary: true },
      { key: "prev", label: "과거 단가", kind: "money", primary: true },
      { key: "peer", label: "타 업체 평균 변동", kind: "signedPercent" },
      { key: "currency", label: "통화", kind: "text" },
      { key: "endDate", label: "계약 종료일", kind: "date" },
    ],
    rows,
    rankLabel: "상승 폭 순",
    cardMetrics: ["changeRate", "price", "prev", "peer"],
    highlights: rows.length ? [{ label: "가장 많이 오른 계약", value: `${rows[0].label} · ${fmtSignedPct(Number(rows[0].values.changeRate))}`, rowId: rows[0].id }, { label: "해당 계약 수", value: `${rows.length}건` }] : [],
    summary: rows.length
      ? [
          `직전 계약 대비 단가가 ${threshold}% 이상 오른 계약은 ${rows.length}건입니다.`,
          `가장 많이 오른 곳은 ${rows[0].label}(${fmtSignedPct(Number(rows[0].values.changeRate))})입니다.`,
          rows.some((r) => r.values.peer !== null && Number(r.values.changeRate) - Number(r.values.peer) >= 5)
            ? `같은 품목 다른 업체보다 5%p 이상 더 오른 계약: ${rows.filter((r) => r.values.peer !== null && Number(r.values.changeRate) - Number(r.values.peer) >= 5).map((r) => r.label).join(", ")}`
            : "",
        ].filter(Boolean)
      : [],
    risks: rows.map((r) => `${r.label}: ${r.risks[0]}${r.values.peer !== null ? ` (타 업체 평균 ${fmtSignedPct(Number(r.values.peer))})` : ""}`),
    reviewPoints: [
      rows.length ? "인상 사유(원자재 시세·환율·사양 변경)는 계약 데이터에 없으므로 협력사 견적 근거를 확인하세요." : "",
      ...rows.filter((r) => r.risks.some((x) => x.includes("계약 종료"))).map((r) => `${r.label}: 계약 종료가 가까워 재계약 협상 일정에 반영하세요.`),
    ].filter(Boolean),
    basis: ["변동률 = (최근 계약 단가 ÷ 직전 계약 단가 − 1) × 100", "단가 추이 차트는 발주 단가의 분기 평균을 첫 분기=100으로 환산한 지수", `기준 ${threshold}%는 ${params.threshold ? "질문에서 지정" : `${EVAL_CONFIG.name}의 예시값`}`],
    sources: [
      { table: "contracts", label: "원가-계약", ids: list.map((c) => c.contractId) },
      { table: "purchaseOrders", label: "구매조달 발주", ids: pairsPos.flatMap((x) => x.pos.map((p) => p.poNo)) },
    ],
    charts: [
      {
        id: "change",
        title: "직전 계약 대비 단가 변동률",
        type: "hbar",
        unit: "%",
        yLabel: "변동률 (%)",
        categories: rows.map((r) => r.label),
        series: [{ key: "change", label: "변동률", values: rows.map((r) => Number(r.values.changeRate)) }],
        digits: 1,
      },
      {
        id: "index",
        title: "분기별 발주 단가 지수 (첫 분기 = 100)",
        type: "line",
        unit: "",
        yLabel: "단가 지수",
        xLabel: "발주 분기",
        categories: qa.labels,
        series: pairsPos.map(({ c, pos }) => {
          const m = priceByQuarter(pos);
          const first = [...m.values()][0]?.value;
          return { key: c.contractId, label: `${c.itemName} · ${c.supplierName}`, values: qa.keys.map((k) => (m.get(k) && first ? round((m.get(k)!.value / first) * 100, 1) : null)) };
        }),
        digits: 1,
      },
    ],
    recommended: "table",
    templates: ["table", "chart", "cards", "report"],
    templateHints: { table: "과거·최근 단가와 변동률 비교", chart: "변동률과 분기별 단가 지수", cards: "계약별 위험 요소", report: "협상 검토 의견 포함" },
  });
  if (!rows.length) res.empty = `직전 계약 대비 단가가 ${threshold}% 이상 오른 계약이 없습니다.`;
  return res;
}

// ─────────────────────────────── 등급별 품질 실적
function gradeQuality(ctx: Ctx, params: AnalysisParams): AnalysisResult {
  const { d } = ctx;
  const grade = params.grade as Grade;
  const list = d.supplierViews.filter((s) => s.evalGrade === grade);
  const rows: ResultRow[] = list
    .map((s) => {
      const ev = d.evaluations.get(s.supplierId)!;
      const q = ev.criteria.find((c) => c.key === "quality")?.score ?? null;
      return {
        id: s.supplierId,
        label: s.name,
        sub: `${s.supplierId} · ${s.process ?? ""}`,
        supplierId: s.supplierId,
        values: { quality: q, defectRate: s.defectRate ?? null, onTimeRate: s.onTimeRate, total: ev.total, auditGrade: s.auditGrade ?? null, items: s.items.length },
        strengths: [q !== null && q >= 90 ? `품질 점수 ${fmtNum(q)}점` : "", s.defectRate != null && s.defectRate <= 0.7 ? `불량률 ${fmtNum(s.defectRate)}%` : "", s.onTimeRate !== null && s.onTimeRate >= 95 ? `납기 준수율 ${fmtPct(s.onTimeRate)}` : ""].filter(Boolean),
        risks: [
          s.auditGrade && s.auditGrade !== grade ? `심사 등급(${s.auditGrade})과 산정 등급(${grade})이 다름` : "",
          s.defectRate != null && s.defectRate >= 1.2 ? `불량률 ${fmtNum(s.defectRate)}%` : "",
          s.onTimeRate !== null && s.onTimeRate < EVAL_CONFIG.lowDeliveryThreshold ? `납기 준수율 ${fmtPct(s.onTimeRate)}` : "",
          ev.missing.length ? `평가 데이터 누락 ${ev.missing.length}건` : "",
        ].filter(Boolean),
        evidence: [ev.criteria.find((c) => c.key === "quality")?.basis ?? "", `최근 심사일 ${s.lastAuditDate ?? "–"}`].filter(Boolean),
        rank: null,
      } as ResultRow;
    })
    .sort((a, b) => Number(b.values.quality ?? 0) - Number(a.values.quality ?? 0))
    .map((r, i) => ({ ...r, rank: i + 1 }));
  const res = base(ctx, params, {
    title: `${grade}등급 협력사 품질 실적`,
    purpose: `산정 등급이 ${grade}인 협력사의 품질 실적을 정리합니다.`,
    scope: [
      { label: "등급", value: `${grade}등급 (산정 등급, ${EVAL_CONFIG.name})` },
      { label: "대상", value: `협력사 ${rows.length}곳` },
      { label: "기준일", value: ctx.meta.asOf },
    ],
    columns: [
      { key: "quality", label: "품질 점수", kind: "number", higherIsBetter: true, primary: true },
      { key: "defectRate", label: "불량률(%)", kind: "number", digits: 1, higherIsBetter: false, primary: true },
      { key: "onTimeRate", label: "납기 준수율", kind: "percent", higherIsBetter: true, primary: true },
      { key: "total", label: "종합 점수", kind: "number", higherIsBetter: true, primary: true },
      { key: "auditGrade", label: "심사 등급", kind: "grade" },
      { key: "items", label: "공급 품목 수", kind: "int" },
    ],
    rows,
    rankLabel: "품질 점수 순",
    cardMetrics: ["quality", "defectRate", "onTimeRate", "total"],
    highlights: rows.length ? [{ label: "품질 점수 최고", value: `${rows[0].label} · ${fmtNum(Number(rows[0].values.quality))}점`, rowId: rows[0].id }, { label: "대상 업체", value: `${rows.length}곳` }] : [],
    summary: rows.length
      ? [
          `${grade}등급 협력사는 ${rows.length}곳이며 품질 점수 평균은 ${fmtNum(rows.reduce((a, r) => a + Number(r.values.quality ?? 0), 0) / rows.length)}점입니다.`,
          `품질 점수가 가장 높은 곳은 ${rows[0].label}(${fmtNum(Number(rows[0].values.quality))}점), 가장 낮은 곳은 ${rows[rows.length - 1].label}(${fmtNum(Number(rows[rows.length - 1].values.quality))}점)입니다.`,
          rows.some((r) => r.risks.some((x) => x.includes("심사 등급"))) ? `심사 등급과 산정 등급이 다른 업체: ${rows.filter((r) => r.risks.some((x) => x.includes("심사 등급"))).map((r) => r.label).join(", ")}` : "",
        ].filter(Boolean)
      : [],
    risks: rows.flatMap((r) => r.risks.slice(0, 1).map((x) => `${r.label}: ${x}`)),
    reviewPoints: [
      rows.some((r) => r.risks.some((x) => x.includes("심사 등급"))) ? "심사 등급과 산정 등급이 다른 업체는 최근 실적 변화 때문인지 확인하세요." : "",
      "품질 점수는 입고검사 기반 입력값과 불량률로 계산하며, 불량 원인은 데이터에 없습니다.",
    ].filter(Boolean),
    basis: [`품질 점수 = ${EVAL_CONFIG.criteria[0].rule}`, `산정 등급 = ${EVAL_CONFIG.name} 종합 점수 기준 (A ≥ 85, B ≥ 75, C ≥ 65)`, "심사 등급 = 협력업체 시트의 입력값"],
    sources: [{ table: "suppliers", label: "협력업체", ids: list.map((s) => s.supplierId) }],
    charts: [
      { id: "q", title: "품질 점수", type: "hbar", unit: "점", yLabel: "품질 점수", categories: rows.map((r) => r.label), series: [{ key: "q", label: "품질 점수", values: rows.map((r) => Number(r.values.quality)) }], digits: 1 },
      { id: "def", title: "불량률", type: "hbar", unit: "%", yLabel: "불량률 (%)", categories: rows.map((r) => r.label), series: [{ key: "d", label: "불량률", values: rows.map((r) => (r.values.defectRate === null ? null : Number(r.values.defectRate))) }], digits: 1 },
    ],
    recommended: "cards",
    templates: ["cards", "table", "chart", "report"],
    templateHints: { cards: "업체별 강점·위험 요소 카드", table: "품질·납기·종합 점수 비교", chart: "품질 점수와 불량률", report: "품질 실적 요약 보고" },
  });
  if (!rows.length) res.empty = `산정 등급이 ${grade}인 협력사가 없습니다.`;
  return res;
}

// ─────────────────────────────── 협력사 평가 근거
function supplierProfile(ctx: Ctx, params: AnalysisParams): AnalysisResult {
  const { d } = ctx;
  const sid = params.supplierIds?.[0] || "";
  const s = d.suppliersById.get(sid);
  if (!s) throw new AnalysisError(`업체 ${sid}를 데이터에서 찾지 못했습니다.`);
  const ev = d.evaluations.get(sid)!;
  const del = d.supplierDelivery.get(sid)!;
  const pos = d.poViews.filter((p) => p.supplierId === sid && p.orderDate >= d.windowFrom);
  const rows: ResultRow[] = ev.criteria.map((c) => ({
    id: c.key,
    label: c.label,
    sub: `가중치 ${c.weight}`,
    supplierId: sid,
    values: { weight: c.weight, score: c.score, weighted: c.score === null ? null : round((c.weight * c.score) / ev.usedWeight, 1), status: c.status === "ok" ? "확인" : c.status === "missing" ? "누락" : "표본 적음", source: c.source },
    strengths: c.score !== null && c.score >= 90 ? [`${c.label} ${fmtNum(c.score)}점 — 상위 수준`] : [],
    risks: c.score === null ? [c.basis] : c.score < 75 ? [`${c.label} ${fmtNum(c.score)}점 — 개선 필요`] : c.status === "low-sample" ? ["표본이 적어 참고용"] : [],
    evidence: [c.basis],
    rank: null,
  }));
  const itemStats = s.items.map((code) => ({ code, name: d.itemsByCode.get(code)?.name ?? code, st: d.pairDelivery.get(`${sid}|${code}`) }));
  const m = deliveryByQuarter(pos);
  return base(ctx, params, {
    title: `${s.name} 평가 근거`,
    purpose: `${s.name}(${sid})의 평가 점수와 항목별 계산 근거를 확인합니다.`,
    scope: [
      { label: "협력사", value: `${s.name} (${sid})` },
      { label: "종합", value: ev.total !== null ? `${ev.grade}등급 · ${fmtNum(ev.total)}점` : "계산 불가" },
      { label: "기준", value: EVAL_CONFIG.name },
      { label: "기간", value: `${d.windowFrom} ~ ${ctx.meta.asOf}` },
    ],
    columns: [
      { key: "score", label: "점수", kind: "number", higherIsBetter: true, primary: true },
      { key: "weight", label: "가중치", kind: "int", primary: true },
      { key: "weighted", label: "반영 점수", kind: "number", primary: true },
      { key: "status", label: "상태", kind: "status", primary: true },
      { key: "source", label: "데이터 출처", kind: "text" },
    ],
    rows,
    cardMetrics: ["score", "weight", "weighted"],
    highlights: [
      { label: "종합", value: ev.total !== null ? `${ev.grade}등급 · ${fmtNum(ev.total)}점` : "계산 불가" },
      { label: "납기 준수율", value: fmtPct(del.rate) },
      { label: "심사 등급(입력)", value: s.auditGrade ? `${s.auditGrade}등급 · ${s.lastAuditDate ?? ""}` : "–" },
    ],
    summary: [
      ev.total !== null ? `${s.name}의 종합 점수는 ${fmtNum(ev.total)}점(${ev.grade}등급)입니다.` : `${s.name}${josa(s.name, "은/는")} 평가 데이터가 부족해 종합 점수를 계산하지 못했습니다.`,
      `가장 높은 항목은 ${[...rows].filter((r) => r.values.score !== null).sort((a, b) => Number(b.values.score) - Number(a.values.score))[0]?.label ?? "–"}, 가장 낮은 항목은 ${[...rows].filter((r) => r.values.score !== null).sort((a, b) => Number(a.values.score) - Number(b.values.score))[0]?.label ?? "–"}입니다.`,
      `공급 품목 ${s.items.length}개: ${itemStats.map((x) => `${x.name}(납기 ${fmtPct(x.st?.rate ?? null)})`).join(", ")}`,
    ],
    risks: [...ev.missing, ...ev.notes],
    reviewPoints: [
      ev.missing.length ? "누락된 평가 항목은 심사 시트에서 값을 확인해 입력하세요." : "",
      s.auditGrade && ev.grade && s.auditGrade !== ev.grade ? `심사 등급(${s.auditGrade})과 산정 등급(${ev.grade})이 다릅니다. 최근 실적 변화를 확인하세요.` : "",
      "점수는 기록된 데이터만으로 계산했으며 담당자의 정성 판단은 포함하지 않았습니다.",
    ].filter(Boolean),
    basis: EVAL_CONFIG.criteria.map((c) => `${c.label} (${c.weight}): ${c.rule}`),
    notes: ev.notes,
    sources: [
      { table: "suppliers", label: "협력업체", ids: [sid] },
      { table: "purchaseOrders", label: "구매조달 발주", ids: pos.map((p) => p.poNo) },
      { table: "contracts", label: "원가-계약", ids: d.contractViews.filter((c) => c.supplierId === sid).map((c) => c.contractId) },
    ],
    charts: [
      { id: "crit", title: "평가 항목별 점수", type: "bar", unit: "점", yLabel: "점수 (0~100)", categories: rows.map((r) => r.label), series: [{ key: "s", label: "점수", values: rows.map((r) => (r.values.score === null ? null : Number(r.values.score))) }], digits: 1, caption: rows.some((r) => r.values.score === null) ? "빈 칸은 데이터 누락 항목" : undefined },
      { id: "q", title: "분기별 납기 준수율", type: "line", unit: "%", yLabel: "납기 준수율 (%)", xLabel: "납기 분기", categories: [...m.values()].map((v) => v.label), series: [{ key: "r", label: s.name, values: [...m.values()].map((v) => v.value) }], digits: 0 },
      { id: "items", title: "품목별 납기 준수율", type: "hbar", unit: "%", yLabel: "납기 준수율 (%)", categories: itemStats.map((x) => x.name), series: [{ key: "r", label: "납기 준수율", values: itemStats.map((x) => x.st?.rate ?? null) }], digits: 1 },
    ],
    recommended: "cards",
    templates: ["cards", "table", "chart", "report"],
    templateHints: { cards: "항목별 점수와 계산 근거", table: "항목·가중치·반영 점수", chart: "항목 점수와 납기 추이", report: "평가 근거 리포트" },
  });
}

// ─────────────────────────────── 협력사 비교
function supplierCompare(ctx: Ctx, params: AnalysisParams): AnalysisResult {
  const { d } = ctx;
  const ids = (params.supplierIds || []).filter((id) => d.suppliersById.has(id));
  if (ids.length < 2) throw new AnalysisError("비교할 협력사를 두 곳 이상 지정해 주세요.");
  const crit = EVAL_CONFIG.criteria;
  const rows: ResultRow[] = ids.map((id) => {
    const s = d.supplierViews.find((x) => x.supplierId === id)!;
    const ev = d.evaluations.get(id)!;
    const vals: Record<string, number | string | null> = { grade: ev.grade, total: ev.total, onTimeRate: s.onTimeRate };
    crit.forEach((c) => (vals[c.key] = ev.criteria.find((x) => x.key === c.key)?.score ?? null));
    const common = s.items.filter((code) => ids.every((other) => d.suppliersById.get(other)?.items.includes(code)));
    vals.common = common.map((c) => d.itemsByCode.get(c)?.name ?? c).join(", ") || "없음";
    return {
      id,
      label: s.name,
      sub: id,
      supplierId: id,
      values: vals,
      strengths: ev.criteria.filter((c) => c.score !== null && c.score >= 90).map((c) => `${c.label} ${fmtNum(c.score)}점`),
      risks: [...ev.criteria.filter((c) => c.score !== null && c.score < 75).map((c) => `${c.label} ${fmtNum(c.score)}점`), ...ev.missing.map((m) => m.split(":")[0] + " 데이터 누락")],
      evidence: ev.criteria.map((c) => `${c.label}: ${c.basis}`),
      rank: null,
    };
  });
  rows.sort((a, b) => Number(b.values.total ?? 0) - Number(a.values.total ?? 0)).forEach((r, i) => (r.rank = i + 1));
  return base(ctx, params, {
    title: `${rows.map((r) => r.label).join(" · ")} 비교`,
    purpose: "지정한 협력사의 평가 항목별 점수를 나란히 비교합니다.",
    scope: [
      { label: "협력사", value: rows.map((r) => r.label).join(", ") },
      { label: "기준", value: EVAL_CONFIG.name },
    ],
    columns: [
      { key: "grade", label: "등급", kind: "grade", primary: true },
      { key: "total", label: "종합", kind: "number", higherIsBetter: true, primary: true },
      ...crit.map((c) => ({ key: c.key, label: c.label, kind: "number" as const, higherIsBetter: true, primary: c.key === "quality" || c.key === "delivery" })),
      { key: "common", label: "공통 품목", kind: "text" },
    ],
    rows,
    rankLabel: "종합 순",
    cardMetrics: ["total", "quality", "delivery", "cost"],
    highlights: [{ label: "종합 점수 최고", value: `${rows[0].label} · ${fmtNum(Number(rows[0].values.total))}점`, rowId: rows[0].id }],
    summary: [
      `${rows.length}개 협력사를 ${EVAL_CONFIG.name}로 비교했습니다.`,
      ...crit.map((c) => {
        const best = [...rows].filter((r) => r.values[c.key] !== null).sort((a, b) => Number(b.values[c.key]) - Number(a.values[c.key]))[0];
        return best ? `${c.label}: ${best.label} ${fmtNum(Number(best.values[c.key]))}점이 가장 높습니다.` : "";
      }),
    ].filter(Boolean),
    risks: rows.flatMap((r) => r.risks.map((x) => `${r.label}: ${x}`)),
    reviewPoints: ["공통 품목이 있으면 '품목별 후보 업체 비교'로 같은 조건의 단가·납기를 확인하세요."],
    basis: crit.map((c) => `${c.label} (${c.weight}): ${c.rule}`),
    sources: [{ table: "suppliers", label: "협력업체", ids }, { table: "purchaseOrders", label: "구매조달 발주", ids: d.poViews.filter((p) => ids.includes(p.supplierId)).map((p) => p.poNo) }],
    charts: [
      {
        id: "crit",
        title: "평가 항목별 점수 비교",
        type: "bar",
        unit: "점",
        yLabel: "점수 (0~100)",
        categories: crit.map((c) => c.label),
        series: rows.slice(0, 4).map((r) => ({ key: r.id, label: r.label, values: crit.map((c) => (r.values[c.key] === null ? null : Number(r.values[c.key]))) })),
        digits: 1,
      },
    ],
    recommended: "table",
    templates: ["table", "chart", "cards", "report"],
    templateHints: { table: "항목별 점수 나란히 비교", chart: "항목별 점수 막대그래프", cards: "업체별 강점·약점", report: "비교 보고서" },
  });
}

// ─────────────────────────────── 재고·공급 위험
function stockRisk(ctx: Ctx, params: AnalysisParams): AnalysisResult {
  const { d } = ctx;
  const order = { "미달·지연": 0, "안전재고 미달": 1, "공급 지연": 2, 정상: 3 } as const;
  const list = d.inventoryViews.filter((v) => v.status !== "정상").sort((a, b) => order[a.status] - order[b.status] || b.shortage - a.shortage);
  const rows: ResultRow[] = list.map((v, i) => ({
    id: v.itemCode,
    label: v.itemName,
    sub: v.itemCode,
    itemCode: v.itemCode,
    supplierId: v.mainSupplierId ?? undefined,
    rank: i + 1,
    values: { status: v.status, stock: v.stockQty, safety: v.safetyStock, shortage: v.shortage, open: v.openOrderQty, expected: v.expectedDate, supplier: v.supplierName },
    strengths: v.openOrderQty >= v.shortage && v.shortage > 0 ? [`발주 잔량 ${v.openOrderQty}${v.unit}으로 부족분 충당 가능`] : [],
    risks: [
      v.shortage > 0 ? `안전재고보다 ${v.shortage}${v.unit} 부족` : "",
      v.overdueOpen ? `납기 경과 미입고 발주 ${v.overdueOpen}건 (${v.supplierName})` : "",
      v.openOrderQty < v.shortage ? `발주 잔량(${v.openOrderQty}${v.unit})이 부족분보다 적음` : "",
    ].filter(Boolean),
    evidence: [`보관 위치: ${v.location ?? "–"}`, `예상 입고일: ${v.expectedDate ?? "없음"}`],
  }));
  const res = base(ctx, params, {
    title: "재고·공급 위험 품목",
    purpose: "안전재고에 못 미치거나 공급이 지연된 품목을 찾아 조달 조치를 정합니다.",
    scope: [
      { label: "기준", value: "현재 재고 < 안전재고, 또는 납기 경과 미입고 발주" },
      { label: "대상", value: `품목 ${d.inventoryViews.length}개` },
      { label: "기준일", value: ctx.meta.asOf },
    ],
    columns: [
      { key: "status", label: "상태", kind: "status", primary: true },
      { key: "stock", label: "현재 재고", kind: "int", primary: true },
      { key: "safety", label: "안전재고", kind: "int", primary: true },
      { key: "shortage", label: "부족 수량", kind: "int", higherIsBetter: false, primary: true },
      { key: "open", label: "발주 잔량", kind: "int" },
      { key: "expected", label: "예상 입고일", kind: "date" },
      { key: "supplier", label: "주 공급업체", kind: "text" },
    ],
    rows,
    rankLabel: "위험 순",
    cardMetrics: ["stock", "safety", "shortage", "open"],
    highlights: rows.length ? [{ label: "위험 품목", value: `${rows.length}개` }, { label: "가장 시급", value: `${rows[0].label} · ${rows[0].values.status}`, rowId: rows[0].id }] : [],
    summary: rows.length ? [`안전재고 미달 또는 공급 지연 품목은 ${rows.length}개입니다.`, `가장 시급한 품목은 ${rows[0].label}(${rows[0].values.status})입니다.`] : [],
    risks: rows.flatMap((r) => r.risks.slice(0, 1).map((x) => `${r.label}: ${x}`)),
    reviewPoints: rows.length ? ["부족 품목의 생산 투입 일정을 생산관리와 확인하세요.", "납기 경과 미입고 발주는 공급업체에 입고 일정을 요청하세요."] : [],
    basis: ["부족 수량 = 안전재고 − 현재 재고", "발주 잔량 = 진행 중·납기 지연 발주 수량 합계", "예상 입고일 = 미입고 발주 중 가장 빠른 납기 예정일"],
    sources: [
      { table: "inventory", label: "자재-공급관리(재고)", ids: list.map((v) => v.itemCode) },
      { table: "purchaseOrders", label: "구매조달 발주", ids: d.poViews.filter((p) => list.some((v) => v.itemCode === p.itemCode) && (p.status === "진행 중" || p.status === "납기 지연")).map((p) => p.poNo) },
    ],
    charts: [
      {
        id: "cover",
        title: "안전재고 대비 현재 재고",
        type: "hbar",
        unit: "%",
        yLabel: "현재 재고 ÷ 안전재고 (%)",
        categories: d.inventoryViews.map((v) => v.itemName),
        series: [{ key: "c", label: "충족률", values: d.inventoryViews.map((v) => (v.safetyStock ? round((v.stockQty / v.safetyStock) * 100, 0) : null)) }],
        refLine: { value: 100, label: "안전재고 100%" },
        statusOf: d.inventoryViews.map((v) => (v.stockQty < v.safetyStock ? "critical" : null)),
        statusLabel: "안전재고 미달",
        digits: 0,
      },
    ],
    recommended: "table",
    templates: ["table", "chart", "cards", "report"],
    templateHints: { table: "재고·부족 수량·입고 예정", chart: "안전재고 충족률", cards: "품목별 위험 요소", report: "조달 조치 검토" },
  });
  if (!rows.length) res.empty = "안전재고 미달이나 공급 지연 품목이 없습니다.";
  return res;
}

export function runAnalysis(params: AnalysisParams, data: DataSet, d: Derived, meta: DataMeta, question: string): AnalysisResult {
  const ctx: Ctx = { data, d, meta, question };
  switch (params.kind) {
    case "item_candidates":
      return itemCandidates(ctx, params);
    case "low_delivery":
      return lowDelivery(ctx, params);
    case "price_increase":
      return priceIncrease(ctx, params);
    case "grade_quality":
      return gradeQuality(ctx, params);
    case "supplier_profile":
      return supplierProfile(ctx, params);
    case "supplier_compare":
      return supplierCompare(ctx, params);
    case "stock_risk":
      return stockRisk(ctx, params);
  }
}

export const ALL_TEMPLATES: TemplateId[] = ["table", "chart", "cards", "report"];
