// AI 계층 ③: 질문 처리 흐름
// 의도 파악 → 대상 확인(없으면 추가 질문) → 데이터 검색·계산 → 결과 요약 → 템플릿 추천
import type { DataMeta, DataSet } from "../data/types";
import type { AnalysisParams, AnalysisResult } from "../lib/analysisTypes";
import { AnalysisError, KIND_LABEL, PRIORITY, runAnalysis, weightText } from "../lib/analysis";
import type { Derived } from "../lib/metrics";
import { fmtNum } from "../lib/format";
import { parseQuestion, type Catalog, type ParsedIntent } from "./intent";
import { buildPrompt, sanitizeLLM, type LLMProvider } from "./llm";

export type Engine = "rule" | "llm";

export interface PendingClarify {
  question: string;
  parsed: ParsedIntent;
  need: "item" | "supplier" | "suppliers";
}

export interface ClarifyOption {
  id: string;
  label: string;
  sub?: string;
}

export type AgentReply =
  | { type: "analysis"; result: AnalysisResult; text: string[]; engine: Engine; engineNote?: string; followup: boolean }
  | { type: "clarify"; text: string[]; options: ClarifyOption[]; pending: PendingClarify; engine: Engine; engineNote?: string }
  | { type: "message"; text: string[]; suggestions?: string[]; engine: Engine; engineNote?: string };

export interface AgentContext {
  data: DataSet;
  derived: Derived;
  meta: DataMeta;
  selection: { supplierId?: string | null; itemCode?: string | null };
  lastResult?: AnalysisResult | null;
  pending?: PendingClarify | null;
}

export const SUGGESTIONS = [
  "해당 품목의 과거 거래 협력사를 비교해 줘.",
  "납기 준수율이 낮은 협력사를 찾아줘.",
  "최근 단가가 상승한 품목을 보여줘.",
  "A등급 협력사의 품질 실적을 정리해 줘.",
];

export const STEPS = ["질문 의도 파악", "대상·데이터 확인", "계산 및 분석", "결과 형식 추천·표시"];

const catalogOf = (data: DataSet): Catalog => ({
  items: data.items.map((i) => ({ itemCode: i.itemCode, name: i.name })),
  suppliers: data.suppliers.map((s) => ({ supplierId: s.supplierId, name: s.name })),
});

function itemOptions(ctx: AgentContext): ClarifyOption[] {
  const counts = new Map<string, number>();
  ctx.derived.poViews.forEach((p) => counts.set(p.itemCode, (counts.get(p.itemCode) || 0) + 1));
  return ctx.data.items
    .map((i) => ({ id: i.itemCode, label: i.name, sub: `${i.itemCode} · 발주 ${counts.get(i.itemCode) ?? 0}건` }))
    .sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0));
}

function supplierOptions(ctx: AgentContext): ClarifyOption[] {
  return ctx.derived.supplierViews.map((s) => ({ id: s.supplierId, label: s.name, sub: `${s.supplierId} · ${s.evalGrade ?? "–"}등급` }));
}

async function interpret(question: string, ctx: AgentContext, llm: LLMProvider | null): Promise<{ parsed: ParsedIntent; engine: Engine; note?: string }> {
  const catalog = catalogOf(ctx.data);
  const rule = parseQuestion(question, catalog, ctx.meta.asOf);
  if (!llm) return { parsed: rule, engine: "rule" };
  try {
    const raw = await llm.interpret(
      buildPrompt(question, catalog, {
        selectedItem: ctx.selection.itemCode ?? undefined,
        selectedSupplier: ctx.selection.supplierId ?? undefined,
        lastAnalysis: ctx.lastResult ? `${ctx.lastResult.kindLabel} (${ctx.lastResult.scope.map((s) => s.value).join(", ")})` : undefined,
      }),
    );
    const parsed = sanitizeLLM(raw, catalog);
    // LLM이 놓친 명시적 표현(기간·기준값)은 규칙 해석으로 보완
    parsed.periodMonths ??= rule.periodMonths;
    parsed.threshold ??= rule.threshold;
    if (parsed.kind === "unknown" && rule.kind !== "unknown") return { parsed: rule, engine: "rule", note: "LLM이 의도를 정하지 못해 규칙 기반 해석을 사용했습니다." };
    return { parsed, engine: "llm" };
  } catch (e) {
    const code = (e as { code?: string })?.code;
    const why = code === "not_granted" ? "Claude 사용이 허용되지 않아" : "LLM 응답을 받지 못해";
    return { parsed: rule, engine: "rule", note: `${why} 규칙 기반 해석으로 처리했습니다.` };
  }
}

function leadText(r: AnalysisResult, usedSelection: string | null, ctx: AgentContext): string[] {
  const p = r.params;
  const out: string[] = [];
  if (usedSelection) out.push(usedSelection);
  if (r.kind === "item_candidates") {
    const item = ctx.derived.itemsByCode.get(p.itemCode!)!;
    const supplierCount = r.rows.length;
    const poCount = r.sources.find((s) => s.table === "purchaseOrders")?.ids.length ?? 0;
    out.push(`${item.name}(${item.itemCode})의 과거 거래 이력을 확인했습니다. 거래 업체 ${supplierCount}곳, 발주 ${poCount}건으로 업체별 등급, 납기 준수율, 최근 거래 단가를 비교할 수 있습니다.`);
    out.push(...r.summary.slice(1, 3));
  } else {
    out.push(...r.summary.slice(0, 2));
  }
  return out;
}

export async function answer(question: string, ctx: AgentContext, llm: LLMProvider | null, onStep?: (i: number) => void): Promise<AgentReply> {
  const step = async (i: number) => {
    onStep?.(i);
    await new Promise((r) => setTimeout(r, 120));
  };
  await step(0);
  const { parsed: fresh, engine, note } = await interpret(question, ctx, llm);
  let parsed = fresh;
  let sourceQuestion = question;

  // 직전에 추가 질문을 했고, 이번 답이 그 빈칸을 채우는 경우 → 원래 질문과 합친다
  if (ctx.pending && (fresh.kind === "unknown" || fresh.kind === ctx.pending.parsed.kind || fresh.kind === "item_candidates" || fresh.kind === "supplier_profile")) {
    const p = ctx.pending;
    if (p.need === "item" && fresh.itemCode) {
      parsed = { ...p.parsed, itemCode: fresh.itemCode, priority: fresh.priority ?? p.parsed.priority };
      sourceQuestion = p.question;
    } else if (p.need === "supplier" && fresh.supplierIds.length) {
      parsed = { ...p.parsed, supplierIds: fresh.supplierIds.slice(0, 1) };
      sourceQuestion = p.question;
    }
  }

  await step(1);
  const sel = ctx.selection;
  let usedSelection: string | null = null;
  let params: AnalysisParams | null = null;
  let followup = false;
  const clarify = (need: PendingClarify["need"], text: string): AgentReply => ({
    type: "clarify",
    text: [text],
    options: need === "item" ? itemOptions(ctx) : supplierOptions(ctx),
    pending: { question: sourceQuestion, parsed, need },
    engine,
    engineNote: note,
  });

  if (parsed.unknownItemRef) {
    return { type: "message", text: [`${parsed.unknownItemRef} 품목을 현재 데이터에서 찾지 못했습니다. 품목코드를 확인하거나 왼쪽 데이터 관리에서 품목을 선택해 주세요.`], engine, engineNote: note };
  }

  switch (parsed.kind) {
    case "item_candidates": {
      let code = parsed.itemCode;
      if (!code && sel.itemCode) {
        code = sel.itemCode;
        usedSelection = `데이터 관리에서 선택한 품목(${ctx.derived.itemsByCode.get(code)?.name ?? code})을 기준으로 분석했습니다.`;
      }
      if (!code) return clarify("item", "어느 품목을 비교할까요? 왼쪽 데이터 관리에서 품목을 고르거나 아래에서 골라 주세요.");
      params = { kind: "item_candidates", itemCode: code, priority: parsed.priority ?? "balanced", periodMonths: parsed.periodMonths };
      break;
    }
    case "priority_followup": {
      const last = ctx.lastResult;
      if (last && last.kind === "item_candidates") {
        params = { ...last.params, priority: parsed.priority ?? "balanced", periodMonths: parsed.periodMonths ?? last.params.periodMonths };
        followup = true;
      } else if (sel.itemCode) {
        params = { kind: "item_candidates", itemCode: sel.itemCode, priority: parsed.priority ?? "balanced", periodMonths: parsed.periodMonths };
        usedSelection = `직전 후보 비교가 없어 데이터 관리에서 선택한 품목(${ctx.derived.itemsByCode.get(sel.itemCode)?.name})으로 비교했습니다.`;
      } else {
        parsed = { ...parsed, kind: "item_candidates" };
        return clarify("item", `${PRIORITY[parsed.priority ?? "balanced"].label} 비교는 품목별 후보 업체 비교에 적용됩니다. 어느 품목을 볼까요?`);
      }
      break;
    }
    case "supplier_profile": {
      let id = parsed.supplierIds[0];
      if (!id && sel.supplierId) {
        id = sel.supplierId;
        usedSelection = `데이터 관리에서 선택한 협력사(${ctx.derived.suppliersById.get(id)?.name ?? id})를 기준으로 정리했습니다.`;
      }
      if (!id) return clarify("supplier", "어느 협력사의 평가를 볼까요?");
      params = { kind: "supplier_profile", supplierIds: [id] };
      break;
    }
    case "supplier_compare":
      params = { kind: "supplier_compare", supplierIds: parsed.supplierIds };
      break;
    case "grade_quality":
      params = { kind: "grade_quality", grade: parsed.grade };
      break;
    case "low_delivery":
      params = { kind: "low_delivery", threshold: parsed.threshold, periodMonths: parsed.periodMonths };
      break;
    case "price_increase":
      params = { kind: "price_increase", threshold: parsed.threshold, itemCode: parsed.itemCode };
      break;
    case "stock_risk":
      params = { kind: "stock_risk" };
      break;
    case "help":
      return {
        type: "message",
        text: [
          "협력사·발주·계약·재고 데이터로 다음을 분석할 수 있습니다: 품목별 후보 업체 비교, 납기 준수율 저조 협력사, 단가 상승 품목, 등급별 품질 실적, 협력사 평가 근거, 재고·공급 위험.",
          "질문하면 알맞은 형식(협력사 비교표·데이터 시각화·종합 평가 카드·분석 보고서)으로 분석 결과창에 바로 보여 드리고, 결과창 상단에서 형식을 바꿀 수 있습니다.",
        ],
        suggestions: SUGGESTIONS,
        engine,
        engineNote: note,
      };
    default:
      return {
        type: "message",
        text: [
          "질문에서 분석할 대상을 찾지 못했습니다. 데이터에 없는 내용은 추측해서 답하지 않습니다.",
          "품목명·협력사명·등급을 넣어 다시 질문하거나 아래 예시를 눌러 보세요.",
        ],
        suggestions: SUGGESTIONS,
        engine,
        engineNote: note,
      };
  }

  await step(2);
  let result: AnalysisResult;
  try {
    result = runAnalysis(params!, ctx.data, ctx.derived, ctx.meta, sourceQuestion);
  } catch (e) {
    if (e instanceof AnalysisError) return { type: "message", text: [e.message], suggestions: SUGGESTIONS, engine, engineNote: note };
    throw e;
  }
  await step(3);

  if (result.empty) {
    return { type: "message", text: [result.empty, "조건(기간·기준값)을 바꿔 다시 질문해 보세요."], engine, engineNote: note };
  }

  let text: string[];
  if (followup) {
    const w = PRIORITY[result.params.priority ?? "balanced"];
    const ranked = result.rows.filter((r) => r.rank).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    text = [
      `직전 분석 대상(${result.scope[0].value}, 업체 ${result.rows.length}곳)을 유지하고 ${w.label} 가중치(${weightText(result.params.priority ?? "balanced")})로 다시 비교했습니다.`,
      `검토 순서: ${ranked.map((r) => `${r.rank}) ${r.label} ${fmtNum(Number(r.values.score))}점`).join(" · ")}`,
      ...result.rows.filter((r) => r.excludedReason).map((r) => `순위 제외: ${r.label} — 비교 조건이 다릅니다(${r.excludedReason}).`),
      "최종 선정은 담당자가 검토 후 확정합니다.",
    ];
  } else {
    text = leadText(result, usedSelection, ctx);
  }
  return { type: "analysis", result, text, engine, engineNote: note, followup };
}

export const kindLabel = KIND_LABEL;
