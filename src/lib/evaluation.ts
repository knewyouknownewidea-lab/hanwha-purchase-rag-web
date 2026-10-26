// 분석 계층 ①: 협력사 평가 점수 계산
// 등급·가중치는 ISO 9001이 정한 것이 아니라 내부 평가 기준 예시(DEMO)다.
// 실제 기준으로 바꿀 때는 EVAL_CONFIG만 수정하면 된다.
import type { Grade } from "../data/types";
import type { Derived } from "./metrics";
import { clamp, fmtNum, round } from "./format";

export type CriterionKey = "quality" | "delivery" | "cost" | "tech" | "esg";

export interface CriterionDef {
  key: CriterionKey;
  label: string;
  weight: number;
  rule: string;
}

export const EVAL_CONFIG = {
  name: "내부 평가 기준 예시 v0.1 (DEMO)",
  windowMonths: 36,
  minSamples: 5,
  lowDeliveryThreshold: 90,
  priceIncreaseThreshold: 5,
  costPenaltyPerPct: 2.5,
  criteria: [
    { key: "quality", label: "품질", weight: 30, rule: "품질평가 점수 × 0.7 + (100 − 불량률% × 10) × 0.3" },
    { key: "delivery", label: "납기", weight: 25, rule: "평가 기간 납기 준수율(%) — 납기 경과 미입고 건은 지연으로 계산" },
    { key: "cost", label: "원가", weight: 20, rule: "동일 조건(품목·규격·통화·인도조건) 최저가 대비 1%당 2.5점 감점" },
    { key: "tech", label: "기술·대응력", weight: 15, rule: "심사 시트 입력값" },
    { key: "esg", label: "경영·ESG", weight: 10, rule: "심사 시트 입력값" },
  ] as CriterionDef[],
  gradeCutoffs: [
    { grade: "A" as Grade, min: 85 },
    { grade: "B" as Grade, min: 75 },
    { grade: "C" as Grade, min: 65 },
    { grade: "D" as Grade, min: 0 },
  ],
};

export type StepStatus = "done" | "warn" | "todo";

export interface CriterionResult {
  key: CriterionKey;
  label: string;
  weight: number;
  score: number | null;
  basis: string;
  source: string;
  status: "ok" | "missing" | "low-sample";
}

export interface SupplierEvaluation {
  supplierId: string;
  total: number | null;
  grade: Grade | null;
  criteria: CriterionResult[];
  missing: string[];
  notes: string[];
  sources: { label: string; count: number }[];
  steps: { label: string; status: StepStatus; detail: string }[];
  usedWeight: number;
}

export function gradeOf(total: number | null): Grade | null {
  if (total === null) return null;
  return EVAL_CONFIG.gradeCutoffs.find((c) => total >= c.min)?.grade ?? "D";
}

/** 품목별 동일 조건 비교 그룹 키 */
export const comparableKey = (c: { itemCode: string; spec?: string; currency: string; deliveryTerms?: string }) =>
  [c.itemCode, c.spec || "", c.currency, c.deliveryTerms || ""].join("|");

export function qualityScore(q: number | null | undefined, defect: number | null | undefined): number | null {
  if (q === null || q === undefined) return null;
  const defectPart = defect === null || defect === undefined ? null : clamp(100 - defect * 10, 0, 100);
  return defectPart === null ? q : round(q * 0.7 + defectPart * 0.3, 1);
}

export function evaluateSupplier(supplierId: string, d: Derived): SupplierEvaluation {
  const s = d.suppliersById.get(supplierId)!;
  const del = d.supplierDelivery.get(supplierId);
  const contracts = d.contractViews.filter((c) => c.supplierId === supplierId);
  const results: CriterionResult[] = [];
  const missing: string[] = [];
  const notes: string[] = [];

  for (const def of EVAL_CONFIG.criteria) {
    let score: number | null = null;
    let basis = "";
    let source = "";
    let status: CriterionResult["status"] = "ok";
    if (def.key === "quality") {
      score = qualityScore(s.qualityScore, s.defectRate);
      source = "협력업체 시트 (품질 평가 점수·불량률)";
      if (score === null) basis = "품질 평가 점수가 없습니다";
      else if (s.defectRate === null || s.defectRate === undefined) basis = `품질평가 ${fmtNum(s.qualityScore!, 0)}점 (불량률 없음 → 품질평가 점수만 반영)`;
      else basis = `품질평가 ${fmtNum(s.qualityScore!, 0)}점 × 0.7 + (100 − 불량률 ${fmtNum(s.defectRate, 1)}% × 10) × 0.3 = ${fmtNum(score, 1)}점`;
    } else if (def.key === "delivery") {
      source = `구매조달 발주 ${del?.evaluated ?? 0}건`;
      if (!del || del.evaluated === 0 || del.rate === null) basis = "평가 기간 내 마감된 발주가 없습니다";
      else {
        score = round(del.rate, 1);
        basis = `마감 발주 ${del.evaluated}건 중 ${del.onTime}건 기한 내 입고 → 준수율 ${fmtNum(del.rate, 1)}%`;
        if (del.overdueOpen) basis += ` (납기 경과 미입고 ${del.overdueOpen}건 포함)`;
        if (del.evaluated < EVAL_CONFIG.minSamples) {
          status = "low-sample";
          notes.push(`납기: 마감 발주 ${del.evaluated}건으로 표본이 적습니다`);
        }
      }
    } else if (def.key === "cost") {
      const parts: { name: string; pct: number; score: number }[] = [];
      for (const c of contracts) {
        const group = d.contractViews.filter((x) => x.comparableKey === c.comparableKey);
        if (group.length < 2) continue;
        const min = Math.min(...group.map((x) => x.unitPrice));
        const pct = (c.unitPrice / min - 1) * 100;
        parts.push({ name: c.itemName, pct, score: clamp(100 - pct * EVAL_CONFIG.costPenaltyPerPct, 0, 100) });
      }
      source = `원가-계약 ${contracts.length}건`;
      if (!parts.length) {
        basis = contracts.length ? "동일 조건으로 비교할 수 있는 다른 업체 단가가 없습니다" : "계약 단가 데이터가 없습니다";
      } else {
        score = round(parts.reduce((a, p) => a + p.score, 0) / parts.length, 1);
        basis = parts.map((p) => `${p.name} 최저가 대비 ${p.pct <= 0.05 ? "최저가" : `+${fmtNum(p.pct, 1)}%`}`).join(" · ") + ` → 평균 ${fmtNum(score, 1)}점`;
      }
    } else {
      const v = def.key === "tech" ? s.techScore : s.esgScore;
      source = "협력업체 시트 (심사 입력값)";
      if (v === null || v === undefined) basis = "심사 입력값이 없습니다";
      else {
        score = v;
        basis = `심사 입력값 ${fmtNum(v, 0)}점`;
      }
    }
    if (score === null) {
      status = "missing";
      missing.push(`${def.label}: ${basis}`);
    }
    results.push({ key: def.key, label: def.label, weight: def.weight, score, basis, source, status });
  }

  const avail = results.filter((r) => r.score !== null);
  const usedWeight = avail.reduce((a, r) => a + r.weight, 0);
  const total = usedWeight >= 60 ? round(avail.reduce((a, r) => a + r.weight * (r.score as number), 0) / usedWeight, 1) : null;
  if (usedWeight < 100 && total !== null) notes.push(`누락 항목을 빼고 가중치 ${usedWeight}점 기준으로 환산했습니다`);
  if (total === null) notes.push("평가 항목의 60% 이상이 있어야 종합 점수를 계산합니다");

  const grade = gradeOf(total);
  const inputs = [s.qualityScore, s.defectRate, s.techScore, s.esgScore].filter((v) => v !== null && v !== undefined).length;
  const steps: SupplierEvaluation["steps"] = [
    { label: "자료 업로드", status: del && del.poCount > 0 ? "done" : "warn", detail: del && del.poCount > 0 ? `발주 ${del.poCount}건 · 계약 ${contracts.length}건` : "발주 이력이 없습니다" },
    { label: "항목 추출", status: inputs >= 3 ? "done" : "warn", detail: `평가 입력값 ${inputs}/4개 확인` },
    { label: "AI 채점", status: total !== null ? "done" : "todo", detail: total !== null ? `${avail.length}개 항목 계산` : "계산 불가" },
    { label: "등급 분류", status: grade ? "done" : "todo", detail: grade ? `${grade}등급 (${fmtNum(total, 1)}점)` : "등급 미정" },
    { label: "근거 리포트", status: grade ? (missing.length || notes.length ? "warn" : "done") : "todo", detail: missing.length ? `확인 필요 ${missing.length}건` : notes.length ? "참고사항 있음" : "근거 확인 완료" },
  ];

  return {
    supplierId,
    total,
    grade,
    criteria: results,
    missing,
    notes,
    sources: [
      { label: "협력업체 시트", count: 1 },
      { label: "구매조달 발주", count: del?.poCount ?? 0 },
      { label: "원가-계약", count: contracts.length },
    ],
    steps,
    usedWeight,
  };
}
