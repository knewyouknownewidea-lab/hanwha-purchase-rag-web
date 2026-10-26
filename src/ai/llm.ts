// AI 계층 ②: LLM 연결 (선택). LLM은 질문 해석만 하고, 수치·업체명·근거는 만들지 않는다.
// 연결 순서: ① claude.ai 아티팩트 런타임(sample) ② 로컬 서버 /api/ai (환경변수 API 키) ③ 없음 → 규칙 기반
import type { Catalog, ParsedIntent, ParsedKind } from "./intent";
import type { Grade } from "../data/types";
import type { PriorityMode } from "../lib/analysisTypes";

export interface LLMProvider {
  id: "artifact" | "server";
  label: string;
  interpret(prompt: string): Promise<unknown>;
}

type ClaudeRuntime = { use: (name: string) => Promise<unknown> };
type SampleFn = ((input: string, opts?: Record<string, unknown>) => Promise<{ text: string }>) & {
  json: (input: string, opts?: Record<string, unknown>) => Promise<unknown>;
};

export function isArtifactViewer(): boolean {
  const c = (window as unknown as { claude?: ClaudeRuntime }).claude;
  return !!c && typeof c.use === "function";
}

function tolerantJSON(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) return JSON.parse(fence[1]);
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a !== -1 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error("JSON 응답이 아닙니다");
  }
}

export async function detectProvider(): Promise<LLMProvider | null> {
  if (isArtifactViewer()) {
    try {
      const c = (window as unknown as { claude: ClaudeRuntime }).claude;
      const sample = (await c.use("sample")) as SampleFn | null;
      if (sample) {
        return {
          id: "artifact",
          label: "Claude (claude.ai 런타임)",
          interpret: (prompt) => sample.json(prompt, { modelTier: "quick" }),
        };
      }
    } catch {
      /* 런타임이 없으면 다음 방법으로 */
    }
    return null;
  }
  try {
    const res = await fetch("/api/ai/status", { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const st = (await res.json()) as { enabled?: boolean; model?: string };
    if (!st.enabled) return null;
    return {
      id: "server",
      label: `서버 LLM (${st.model ?? "환경변수 설정"})`,
      interpret: async (prompt) => {
        const r = await fetch("/api/ai/interpret", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt }),
        });
        if (!r.ok) throw new Error(`서버 응답 ${r.status}`);
        const body = (await r.json()) as { text?: string; error?: string };
        if (body.error) throw new Error(body.error);
        return tolerantJSON(body.text ?? "");
      },
    };
  } catch {
    return null;
  }
}

const KINDS: ParsedKind[] = ["item_candidates", "low_delivery", "price_increase", "grade_quality", "supplier_profile", "supplier_compare", "stock_risk", "priority_followup", "help", "unknown"];

export function buildPrompt(question: string, catalog: Catalog, context: { selectedItem?: string; selectedSupplier?: string; lastAnalysis?: string }) {
  return [
    "당신은 구매·협력사 데이터 분석 도구의 질문 해석기입니다. 사용자의 한국어 질문을 아래 JSON 하나로만 바꾸세요.",
    "수치나 업체명을 새로 만들지 말고, 목록에 있는 코드만 사용하세요. 모르면 null로 두세요.",
    "",
    "intent 값:",
    "- item_candidates: 특정 품목의 과거 거래 업체·후보 업체 비교",
    "- low_delivery: 납기 준수율이 낮은 협력사 찾기",
    "- price_increase: 단가가 오른 품목·계약 찾기",
    "- grade_quality: 특정 등급(A~D) 협력사의 품질 실적",
    "- supplier_profile: 협력사 한 곳의 평가 점수와 근거",
    "- supplier_compare: 협력사 두 곳 이상 비교",
    "- stock_risk: 안전재고 미달·공급 지연 품목",
    "- priority_followup: 직전 비교에서 우선순위(납기/단가/품질)만 바꾸는 후속 질문",
    "- help: 사용법 질문",
    "- unknown: 위에 해당하지 않음",
    "",
    'JSON 형식: {"intent": string, "itemCode": string|null, "supplierIds": string[], "grade": "A"|"B"|"C"|"D"|null, "priority": "balanced"|"delivery"|"price"|"quality"|null, "periodMonths": number|null, "threshold": number|null, "refersToSelection": boolean}',
    'refersToSelection은 "해당 품목", "이 업체"처럼 화면에서 선택한 대상을 가리키면 true.',
    "",
    `품목 목록: ${catalog.items.map((i) => `${i.itemCode}=${i.name}`).join(", ")}`,
    `협력사 목록: ${catalog.suppliers.map((s) => `${s.supplierId}=${s.name}`).join(", ")}`,
    `화면에서 선택한 품목: ${context.selectedItem ?? "없음"} / 선택한 협력사: ${context.selectedSupplier ?? "없음"}`,
    `직전 분석: ${context.lastAnalysis ?? "없음"}`,
    "",
    `질문: ${question}`,
  ].join("\n");
}

/** LLM 응답을 검증해 목록에 있는 값만 남긴다 */
export function sanitizeLLM(raw: unknown, catalog: Catalog): ParsedIntent {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kind = KINDS.includes(o.intent as ParsedKind) ? (o.intent as ParsedKind) : "unknown";
  const itemCode = catalog.items.some((i) => i.itemCode === o.itemCode) ? (o.itemCode as string) : undefined;
  const supplierIds = Array.isArray(o.supplierIds) ? (o.supplierIds as unknown[]).map(String).filter((id) => catalog.suppliers.some((s) => s.supplierId === id)) : [];
  const grade = ["A", "B", "C", "D"].includes(String(o.grade)) ? (o.grade as Grade) : undefined;
  const priority = ["balanced", "delivery", "price", "quality"].includes(String(o.priority)) ? (o.priority as PriorityMode) : undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  return {
    kind,
    itemCode,
    supplierIds,
    grade,
    priority,
    periodMonths: num(o.periodMonths),
    threshold: num(o.threshold),
    refersToSelection: o.refersToSelection === true,
  };
}
