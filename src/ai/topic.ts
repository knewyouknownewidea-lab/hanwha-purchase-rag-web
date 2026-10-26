// 질문 → 오른쪽 분석 화면 주제. 원자재·직종은 화면 데이터의 이름과 정확히 대조하며(구매 DB RAG의 query_rules.py와 같은 규칙),
// 대상이 없거나 여러 개면 그래프를 그리지 않고 추가 선택을 요청한다.
import type { DataSet } from "../data/types";
import type { Derived } from "../lib/metrics";
import type { NegotiationFacts, NegotiationResult } from "../lib/negotiation";
import { findItem, findPeriod, findSuppliers } from "./intent";

export type Market = "국제" | "국내";
export type Topic =
  | { kind: "material"; question: string; material: string; market: Market | null; months: number | null }
  | { kind: "wage"; question: string; path: string[]; months: number | null }
  | { kind: "unclear"; question: string; message: string; options: { label: string; ask?: string }[]; pending?: unknown }
  | { kind: "negotiation"; question: string; supplierId: string; itemCode: string; quotePct: number | null; draft?: NegotiationDraft };

/** 서버(LangChain 체인)가 작성한 협상 보고서·이메일 초안과, 서버가 다시 계산한 값 */
export interface NegotiationDraft {
  state: "drafting" | "done" | "failed";
  facts?: NegotiationFacts;
  status?: string;
  result?: NegotiationResult;
  report?: string;
  email?: string;
  note?: string;
  message?: string;
}

const NEGOTIATION_TERMS = /인상|견적|협상|올려|올리|올린|단가\s*조정/;

/** 단가 인상 협상 질문: 협력사·품목을 계약 데이터에서 하나로 정한다. 여러 개면 추측하지 않고 고르게 한다 */
export function detectNegotiationTopic(question: string, derived: Derived): Topic | null {
  if (!NEGOTIATION_TERMS.test(question)) return null;
  const sups = findSuppliers(question, [...derived.suppliersById.values()]);
  const itemCode = findItem(question, [...derived.itemsByCode.values()]);
  if (!sups.length && !itemCode) return null;
  const pct = question.match(/(\d+(?:\.\d+)?)\s*%/);
  const quotePct = pct ? Number(pct[1]) : null;
  const name = (id: string) => derived.suppliersById.get(id)?.name ?? id;
  const itemName = (code: string) => derived.itemsByCode.get(code)?.name ?? code;
  const contracts = derived.contractViews.filter((c) => (!sups.length || sups.includes(c.supplierId)) && (!itemCode || c.itemCode === itemCode));
  if (sups.length > 1)
    return { kind: "unclear", question, message: `협력사가 여러 곳입니다 (${sups.map(name).join(", ")}). 한 곳을 골라 주세요.`, options: sups.map((id) => ({ label: name(id), ask: `${name(id)} ${itemCode ? itemName(itemCode) + " " : ""}단가 인상 검토` })) };
  if (contracts.length === 1) return { kind: "negotiation", question, supplierId: contracts[0].supplierId, itemCode: contracts[0].itemCode, quotePct };
  if (!contracts.length)
    return { kind: "unclear", question, message: "질문한 협력사·품목의 계약 단가가 데이터에 없습니다. 협력사와 품목을 확인해 주세요.", options: [] };
  return {
    kind: "unclear",
    question,
    message: `계약이 여러 건입니다. 협상할 ${sups.length ? "품목" : "협력사"}을 골라 주세요.`,
    options: contracts.map((c) => {
      const label = sups.length ? c.itemName : c.supplierName;
      return { label, ask: `${c.supplierName} ${c.itemName} 단가 인상 검토${quotePct != null ? ` ${quotePct}%` : ""}` };
    }),
  };
}

const compact = (s: string) => s.replace(/\s+/g, "");
const MATERIAL_TERMS = /원자재|시세/;
const WAGE_TERMS = /인건비|임금|급여|노임|직종/;

/** 원자재 시세·인건비 질문이면 주제를, 아니면 null(기존 웹 데이터 분석으로 처리)을 돌려준다 */
export function detectMarketTopic(question: string, data: Pick<DataSet, "materialPrices" | "laborWages">, asOf: string): Topic | null {
  const q = compact(question);
  const materials = [...new Set(data.materialPrices.map((m) => m.material))].sort();
  const jobs = new Map<string, string[]>();
  for (const w of data.laborWages) jobs.set(w.minor, [w.major, w.mid, w.minor]);
  const matHits = materials.filter((m) => q.includes(compact(m)));
  const jobHits = [...jobs.keys()].filter((j) => q.includes(compact(j)));
  const wantsMat = matHits.length > 0 || MATERIAL_TERMS.test(question);
  const wantsJob = jobHits.length > 0 || WAGE_TERMS.test(question);
  if (!wantsMat && !wantsJob) return null;
  const months = findPeriod(question, asOf);
  if (wantsMat && wantsJob)
    return { kind: "unclear", question, message: "원자재 시세와 인건비가 함께 들어 있습니다. 하나를 골라 주세요.", options: [...matHits.map((m) => ({ label: m, ask: `${m} 시세` })), ...jobHits.map((j) => ({ label: j, ask: `${j} 인건비` }))] };
  const [hits, all, word, label] = wantsMat ? [matHits, materials, "시세", "원자재"] : [jobHits, [...jobs.keys()], "인건비", "직종"];
  if (!all.length) return { kind: "unclear", question, message: `${label} 데이터가 없습니다. ${wantsMat ? "원자재 시세" : "인건비 동향"} 탭에서 파일을 불러와 주세요.`, options: [] };
  if (hits.length !== 1)
    return {
      kind: "unclear",
      question,
      message: hits.length ? `${label}이 여러 개입니다 (${hits.join(", ")}). 하나를 골라 주세요.` : `어떤 ${label}인지 질문에서 찾지 못했습니다. 아래에서 골라 주세요.`,
      options: (hits.length ? hits : all).map((n) => ({ label: n, ask: `${n} ${word}` })),
    };
  if (wantsMat) {
    const market: Market | null = /국제|해외|LME/i.test(question) ? "국제" : /국내/.test(question) ? "국내" : null;
    return { kind: "material", question, material: hits[0], market, months };
  }
  return { kind: "wage", question, path: jobs.get(hits[0])!, months };
}

export const topicConditions = (t: Topic): { label: string; value: string }[] =>
  t.kind === "material"
    ? [{ label: "원자재", value: t.material }, { label: "시장", value: t.market ?? "국내·국제" }, { label: "기간", value: t.months ? `최근 ${t.months}개월` : "지정 없음 (기본 12개월)" }]
    : t.kind === "wage"
      ? [{ label: "직종", value: t.path.join(" › ") }, { label: "기간", value: t.months ? `최근 ${t.months}개월` : "지정 없음 (기본 24개월)" }]
      : [];
