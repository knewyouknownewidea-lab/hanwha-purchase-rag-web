import type { DataMeta, DataSet } from "../data/types";
import type { AnalysisResult } from "./analysisTypes";
import type { Derived } from "./metrics";

export type ComparisonStatus = "comparable" | "needs_confirmation" | "excluded";
export const PRICE_STATUS_LABEL: Record<ComparisonStatus, string> = { comparable: "비교 가능", needs_confirmation: "조건 확인 필요", excluded: "비교 제외" };
export interface PriceConditions {
  itemCode?: string | null;
  drawing?: string | null;
  specification?: string | null;
  material?: string | null;
  processing?: string | null;
  inspection?: string | null;
  quantity?: number | null;
  unit?: string | null;
  currency?: string | null;
  priceDate?: string | null;
  taxTerms?: string | null;
  transportTerms?: string | null;
  deliveryTerms?: string | null;
}
export type PriceConditionKey = keyof PriceConditions;
export interface PriceConditionCheck { field: PriceConditionKey | "unitPrice" | "source" | "dataId"; label: string; status: ComparisonStatus; reason: string }
export interface PriceSource { documentId: string; title: string; date: string; page?: string; url?: string }
export interface SupplierPriceRecord {
  id: string; supplierId: string; itemCode: string; unitPrice: number | null;
  conditions: PriceConditions; source: PriceSource; isSample: boolean;
  kind: "supplier_quote" | "contract"; linkedContractId?: string;
}
export interface ExternalFinishedQuote {
  id: string; itemCode: string; supplierName: string; unitPrice: number | null;
  conditions: PriceConditions; source: PriceSource; isSample: boolean;
  kind: "external_finished_quote";
}
export interface PriceEvidence {
  id: string; itemCode: string; supplierIds: string[]; recordIds: string[];
  title: string; date: string; page?: string; text: string; isSample: boolean;
  conditions?: PriceConditions;
}
export interface MarketIndicator {
  id: string; kind: "fx" | "material" | "index"; label: string;
  status: "connected" | "unavailable" | "not_configured" | "example" | "loading";
  value: number | null; unit: string; currency: string | null;
  source: string; sourceUrl: string | null; observedAt: string | null; fetchedAt: string | null;
  message: string; isSample: boolean;
}
export interface PriceInputs {
  revision: string; dataId: string; asOf: string; conditions: PriceConditions;
  supplierQuotes: SupplierPriceRecord[]; externalQuotes: ExternalFinishedQuote[];
  contractConditions: Record<string, PriceConditions>;
  evidence: PriceEvidence[]; indicators: MarketIndicator[];
}
export interface EvaluatedExternalQuote extends ExternalFinishedQuote {
  status: ComparisonStatus; statusLabel: string; reasons: string[]; checks: PriceConditionCheck[];
}
export interface PriceBenchmark {
  median: number | null; count: number; min: number | null; max: number | null;
  usedQuoteIds: string[]; status: ComparisonStatus; reasons: string[];
}
export interface PriceRowAnalysis {
  supplierId: string; supplierName: string; itemCode: string; recordId: string | null;
  record: SupplierPriceRecord | null; supplierPrice: number | null;
  benchmark: number | null; delta: number | null; deltaPct: number | null;
  status: ComparisonStatus; statusLabel: string; reasons: string[]; checks: PriceConditionCheck[];
  evidence: PriceEvidence[];
}
export interface PriceAnalysis {
  id: string; revision: string; dataId: string; dataVersion: number; asOf: string;
  item: { itemCode: string; name: string; spec: string | null; unit: string | null };
  supplierIds: string[]; conditions: PriceConditions; inputs: PriceInputs;
  benchmark: PriceBenchmark; externalQuotes: EvaluatedExternalQuote[]; rows: PriceRowAnalysis[];
  evidence: PriceEvidence[]; indicators: MarketIndicator[]; dataLabel: string; isSample: boolean; notes: string[];
}
export interface PriceAnalysisSelection { itemCode: string; supplierIds?: string[]; asOf?: string }
export interface PriceRagContext {
  analysis_id: string; revision: string; data_id: string; as_of: string;
  item: PriceAnalysis["item"]; supplier_ids: string[]; conditions: PriceConditions;
  supplier_quotes: SupplierPriceRecord[]; external_quotes: ExternalFinishedQuote[];
  computed: { benchmark: PriceBenchmark; rows: Pick<PriceRowAnalysis, "supplierId" | "supplierName" | "recordId" | "status" | "supplierPrice" | "benchmark" | "delta" | "deltaPct" | "reasons">[] };
  evidence_ids: string[]; indicators: MarketIndicator[];
}

export const PRICE_CONDITION_LABELS: Record<PriceConditionKey, string> = {
  itemCode: "품목", drawing: "도면", specification: "규격", material: "재질", processing: "가공 요구사항", inspection: "검사 조건",
  quantity: "구매 수량", unit: "단위", currency: "통화", priceDate: "가격 기준일", taxTerms: "세금 조건", transportTerms: "운송비 조건", deliveryTerms: "납품 조건",
};
const CONDITION_KEYS = Object.keys(PRICE_CONDITION_LABELS) as PriceConditionKey[];
const clean = (value: string) => value.trim().replace(/\s+/g, " ");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const missing = (value: unknown) => value === null || value === undefined || (typeof value === "string" && !value.trim());
const validMoney = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER;
export function isPriceDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function invalidCondition(key: PriceConditionKey, value: unknown): boolean {
  if (missing(value)) return false;
  if (key === "quantity") return !validMoney(value);
  if (typeof value !== "string") return true;
  if (key === "priceDate") return !isPriceDate(value);
  if (key === "currency") return !/^[A-Z]{3}$/.test(clean(value));
  return value.length > 2000;
}
function statusOf(checks: PriceConditionCheck[]): ComparisonStatus {
  return checks.some((check) => check.status === "excluded") ? "excluded" : checks.some((check) => check.status === "needs_confirmation") ? "needs_confirmation" : "comparable";
}

/** 누락을 일치로 보지 않고, 검증되지 않은 환율·수량·원가 보정을 하지 않습니다. */
export function checkPriceConditions(expected: PriceConditions, actual: PriceConditions): PriceConditionCheck[] {
  return CONDITION_KEYS.map((field) => {
    const label = PRICE_CONDITION_LABELS[field];
    const a = expected?.[field], b = actual?.[field];
    if (invalidCondition(field, a) || invalidCondition(field, b)) return { field, label, status: "excluded", reason: `${label} 값의 형식이나 범위가 올바르지 않습니다.` };
    if (missing(a) || missing(b)) return { field, label, status: "needs_confirmation", reason: `${label} ${missing(a) ? "기준" : "견적"} 조건이 누락되어 확인이 필요합니다.` };
    if ((typeof a === "string" ? clean(a) : a) !== (typeof b === "string" ? clean(b) : b)) return { field, label, status: "excluded", reason: `${label} 차이: 기준 ${String(a)} / 견적 ${String(b)}` };
    return { field, label, status: "comparable", reason: `${label} 일치` };
  });
}

export function medianValidPrices(values: readonly (number | null | undefined)[]): number | null {
  const valid = values.filter(validMoney).sort((a, b) => a - b);
  if (!valid.length) return null;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[middle] : valid[middle - 1] / 2 + valid[middle] / 2;
}

function recordChecks(target: PriceConditions, record: SupplierPriceRecord | ExternalFinishedQuote): PriceConditionCheck[] {
  const checks = checkPriceConditions(target, record.conditions);
  if (!missing(record.conditions.itemCode) && record.itemCode !== record.conditions.itemCode) checks.push({ field: "itemCode", label: "품목", status: "excluded", reason: "가격 레코드의 품목과 견적 조건의 품목이 다릅니다." });
  if (record.unitPrice === null || record.unitPrice === undefined) checks.push({ field: "unitPrice", label: "단가", status: "needs_confirmation", reason: "단가가 누락되어 확인이 필요합니다." });
  else if (!validMoney(record.unitPrice)) checks.push({ field: "unitPrice", label: "단가", status: "excluded", reason: "단가는 0보다 크고 유한한 안전 범위의 숫자여야 합니다." });
  const source = record.source;
  if (!source || missing(source.documentId) || missing(source.title) || missing(source.date)) checks.push({ field: "source", label: "가격 근거", status: "needs_confirmation", reason: "가격 근거 문서 식별자·문서명·일자를 확인해야 합니다." });
  else if (typeof source.documentId !== "string" || typeof source.title !== "string") checks.push({ field: "source", label: "가격 근거", status: "excluded", reason: "가격 근거 문서 식별자·문서명의 형식이 올바르지 않습니다." });
  else if (!isPriceDate(source.date)) checks.push({ field: "source", label: "가격 근거", status: "excluded", reason: "가격 근거 문서 일자가 올바르지 않습니다." });
  else if (isPriceDate(record.conditions.priceDate) && source.date !== record.conditions.priceDate) checks.push({ field: "priceDate", label: "가격 기준일", status: "excluded", reason: "가격 근거 문서 일자와 견적의 가격 기준일이 다릅니다." });
  return checks;
}

let sequence = 0;
function identity() { return `price-${Date.now().toString(36)}-${(sequence++).toString(36)}`; }
function unique<T>(values: T[]) { return [...new Set(values)]; }
function reasons(checks: PriceConditionCheck[]) { return unique(checks.filter((check) => check.status !== "comparable").map((check) => check.reason)); }

/** 브라우저 저장본의 모양만 검증합니다. 누락 조건·0원은 계산 단계에서 상태와 사유를 유지합니다. */
export function normalizePriceInputs(value: unknown): PriceInputs | null {
  if (!object(value) || typeof value.revision !== "string" || !value.revision || value.revision.length > 128 || typeof value.dataId !== "string" || !value.dataId || !isPriceDate(value.asOf) || !object(value.conditions) || !object(value.contractConditions)) return null;
  const conditionShape = (entry: unknown) => object(entry) && Object.entries(entry).every(([key, item]) => CONDITION_KEYS.includes(key as PriceConditionKey) && (item === null || item === undefined || (key === "quantity" ? typeof item === "number" : typeof item === "string" && item.length <= 2000)));
  const sourceShape = (entry: unknown) => object(entry) && ["documentId", "title", "date"].every((key) => typeof entry[key] === "string" && (entry[key] as string).length <= 2000) && ["page", "url"].every((key) => entry[key] === undefined || typeof entry[key] === "string");
  const quotesShape = (entries: unknown, external: boolean) => Array.isArray(entries) && entries.length <= 100 && entries.every((entry) => object(entry) && typeof entry.id === "string" && !!entry.id && typeof entry.itemCode === "string" && (entry.unitPrice === null || typeof entry.unitPrice === "number") && typeof entry.isSample === "boolean" && conditionShape(entry.conditions) && sourceShape(entry.source) && (external ? entry.kind === "external_finished_quote" && typeof entry.supplierName === "string" : ["supplier_quote", "contract"].includes(String(entry.kind)) && typeof entry.supplierId === "string"));
  if (!conditionShape(value.conditions) || !Object.values(value.contractConditions).every(conditionShape) || !quotesShape(value.supplierQuotes, false) || !quotesShape(value.externalQuotes, true)) return null;
  if (!Array.isArray(value.evidence) || value.evidence.length > 200 || !value.evidence.every((entry) => object(entry) && ["id", "itemCode", "title", "date", "text"].every((key) => typeof entry[key] === "string") && typeof entry.isSample === "boolean" && ["supplierIds", "recordIds"].every((key) => Array.isArray(entry[key]) && (entry[key] as unknown[]).every((id) => typeof id === "string")) && (entry.conditions === undefined || conditionShape(entry.conditions)))) return null;
  if (!Array.isArray(value.indicators) || value.indicators.length > 20 || !value.indicators.every((entry) => object(entry) && typeof entry.id === "string" && typeof entry.label === "string" && ["fx", "material", "index"].includes(String(entry.kind)) && ["connected", "unavailable", "not_configured", "example", "loading"].includes(String(entry.status)) && (entry.value === null || typeof entry.value === "number" && Number.isFinite(entry.value)) && ["currency", "sourceUrl", "observedAt", "fetchedAt"].every((key) => entry[key] === null || typeof entry[key] === "string") && typeof entry.unit === "string" && typeof entry.source === "string" && typeof entry.message === "string" && typeof entry.isSample === "boolean")) return null;
  try { return structuredClone(value) as unknown as PriceInputs; } catch { return null; }
}

export function updateExternalQuote(inputs: PriceInputs, id: string, unitPrice: number | null): PriceInputs {
  if (!inputs.externalQuotes.some((quote) => quote.id === id)) throw new Error("변경할 외부 완성부품 견적을 찾지 못했습니다.");
  if (Object.is(inputs.externalQuotes.find((quote) => quote.id === id)!.unitPrice, unitPrice)) return inputs;
  const next = structuredClone(inputs);
  next.revision = identity();
  next.externalQuotes = next.externalQuotes.map((quote) => quote.id === id ? { ...quote, unitPrice } : quote);
  return next;
}

function contractRecords(data: DataSet, inputs: PriceInputs, itemCode: string): SupplierPriceRecord[] {
  const item = data.items.find((row) => row.itemCode === itemCode);
  return data.contracts.filter((contract) => contract.itemCode === itemCode).map((contract) => ({
    id: contract.contractId, supplierId: contract.supplierId, itemCode, unitPrice: contract.unitPrice, isSample: false, kind: "contract",
    conditions: { ...inputs.contractConditions[contract.contractId], itemCode, specification: contract.spec ?? item?.spec ?? null, currency: contract.currency, unit: item?.unit ?? null, deliveryTerms: contract.deliveryTerms ?? null },
    source: { documentId: `contract:${contract.contractId}`, title: `현재 계약 ${contract.contractId}`, date: contract.startDate ?? "" },
  }));
}

function matchingEvidence(evidence: PriceEvidence[], record: SupplierPriceRecord | ExternalFinishedQuote): PriceEvidence[] {
  return evidence.filter((doc) => doc.id === record.source?.documentId && doc.title === record.source.title && doc.date === record.source.date && doc.page === record.source.page && doc.itemCode === record.itemCode && doc.recordIds.includes(record.id) && (!("supplierId" in record) || doc.supplierIds.includes(record.supplierId)) && (!doc.conditions || checkPriceConditions(doc.conditions, record.conditions).every((check) => check.status === "comparable")));
}

export function buildPriceAnalysis(data: DataSet, meta: DataMeta, inputs: PriceInputs, selection: PriceAnalysisSelection): PriceAnalysis {
  const item = data.items.find((row) => row.itemCode === selection.itemCode);
  if (!item) throw new Error("가격을 비교할 품목을 현재 데이터에서 찾지 못했습니다.");
  const snapshot = structuredClone(inputs);
  const asOf = selection.asOf ?? meta.asOf;
  const shared: PriceConditionCheck[] = [];
  if (inputs.dataId !== meta.dataId) shared.push({ field: "dataId", label: "자료 버전", status: "needs_confirmation", reason: "가격 비교 조건·외부 견적이 이전 웹 데이터에 연결되어 있습니다. 현재 자료의 조건을 다시 확인해 주세요." });
  if (!isPriceDate(asOf)) shared.push({ field: "priceDate", label: "기준일", status: "excluded", reason: "분석 기준일이 올바르지 않습니다." });
  else if (isPriceDate(inputs.conditions.priceDate) && asOf !== inputs.conditions.priceDate) shared.push({ field: "priceDate", label: "기준일", status: "excluded", reason: "분석 기준일과 비교 조건의 가격 기준일이 다릅니다." });
  if (inputs.conditions.itemCode !== item.itemCode) shared.push({ field: "itemCode", label: "품목", status: "needs_confirmation", reason: "선택 품목의 가격 비교 조건을 확인해야 합니다." });
  const duplicateIds = new Set(inputs.externalQuotes.filter((quote, i, all) => all.findIndex((other) => other.id === quote.id) !== i).map((quote) => quote.id));
  const externalQuotes: EvaluatedExternalQuote[] = snapshot.externalQuotes.filter((quote) => quote.itemCode === item.itemCode).map((quote) => {
    const checks = [...recordChecks(inputs.conditions, quote), ...shared];
    if (quote.kind !== "external_finished_quote") checks.push({ field: "source", label: "외부 가격 구분", status: "excluded", reason: "완성부품 외부 견적·거래가격이 아닙니다." });
    if (duplicateIds.has(quote.id)) checks.push({ field: "source", label: "견적 식별자", status: "excluded", reason: "외부 견적 식별자가 중복되어 집계에서 제외합니다." });
    const status = statusOf(checks);
    return { ...quote, status, statusLabel: PRICE_STATUS_LABEL[status], checks, reasons: reasons(checks) };
  });
  const valid = externalQuotes.filter((quote) => quote.status === "comparable" && validMoney(quote.unitPrice));
  const prices = valid.map((quote) => quote.unitPrice!);
  const median = medianValidPrices(prices);
  const benchmark: PriceBenchmark = { median, count: valid.length, min: prices.length ? Math.min(...prices) : null, max: prices.length ? Math.max(...prices) : null, usedQuoteIds: valid.map((quote) => quote.id), status: median === null ? "needs_confirmation" : "comparable", reasons: median === null ? ["비교 조건을 모두 충족한 유효한 외부 완성부품 견적이 없어 시장 참고가격을 계산할 수 없습니다."] : [] };
  const actualContracts = contractRecords(data, inputs, item.itemCode);
  const currentQuotes = inputs.dataId === meta.dataId ? snapshot.supplierQuotes.filter((quote) => quote.itemCode === item.itemCode) : [];
  const knownIds = new Set([...actualContracts, ...currentQuotes].map((record) => record.supplierId));
  data.suppliers.filter((supplier) => supplier.items.includes(item.itemCode)).forEach((supplier) => knownIds.add(supplier.supplierId));
  const chosen = selection.supplierIds?.length ? new Set(selection.supplierIds) : knownIds;
  const rows: PriceRowAnalysis[] = data.suppliers.filter((supplier) => chosen.has(supplier.supplierId)).map((supplier) => {
    const quotes = currentQuotes.filter((quote) => quote.supplierId === supplier.supplierId);
    const contracts = actualContracts.filter((record) => record.supplierId === supplier.supplierId);
    const candidates = quotes.length ? quotes : contracts;
    const record = candidates.length === 1 ? candidates[0] : null;
    const checks: PriceConditionCheck[] = record ? [...recordChecks(inputs.conditions, record), ...shared] : [...shared, { field: "unitPrice", label: "협력사 단가", status: "needs_confirmation", reason: candidates.length ? "같은 업체·품목의 가격 레코드가 여러 개입니다. 사용할 견적·계약 하나를 확인해 주세요." : "현재 자료에 해당 업체·품목의 협력사 견적·계약 단가가 없습니다." }];
    if (record && !["supplier_quote", "contract"].includes(record.kind)) checks.push({ field: "source", label: "협력사 가격 구분", status: "excluded", reason: "협력사 견적·계약 단가 레코드가 아닙니다." });
    if (record?.linkedContractId && !data.contracts.some((contract) => contract.contractId === record.linkedContractId && contract.supplierId === record.supplierId && contract.itemCode === record.itemCode)) checks.push({ field: "source", label: "기존 계약 연결", status: "needs_confirmation", reason: "신규 견적에 연결된 기존 계약의 업체·품목을 현재 데이터에서 확인하지 못했습니다." });
    if (median === null) checks.push({ field: "source", label: "시장 참고가격", status: "needs_confirmation", reason: benchmark.reasons[0] });
    const supplierPrice = record && validMoney(record.unitPrice) ? record.unitPrice : null;
    if (statusOf(checks) === "comparable" && supplierPrice !== null && median !== null && !Number.isFinite((supplierPrice - median) / median * 100)) checks.push({ field: "unitPrice", label: "차이율", status: "excluded", reason: "가격 차이율이 유한한 수치 범위를 벗어나 계산에서 제외합니다." });
    const status = statusOf(checks);
    const delta = status === "comparable" && supplierPrice !== null && median !== null ? supplierPrice - median : null;
    const deltaPct = delta !== null && median !== null ? delta / median * 100 : null;
    return { supplierId: supplier.supplierId, supplierName: supplier.name, itemCode: item.itemCode, recordId: record?.id ?? null, record, supplierPrice, benchmark: median, delta, deltaPct, status, statusLabel: PRICE_STATUS_LABEL[status], reasons: reasons(checks), checks, evidence: record ? matchingEvidence(snapshot.evidence, record) : [] };
  });
  const evidence = unique([...rows.flatMap((row) => row.evidence), ...externalQuotes.flatMap((quote) => matchingEvidence(snapshot.evidence, quote))]);
  const isSample = meta.isSample || [...rows.flatMap((row) => row.record ? [row.record] : []), ...externalQuotes].some((record) => record.isSample);
  return {
    id: identity(), revision: inputs.revision, dataId: meta.dataId, dataVersion: meta.version, asOf,
    item: { itemCode: item.itemCode, name: item.name, spec: item.spec ?? null, unit: item.unit ?? null }, supplierIds: rows.map((row) => row.supplierId),
    conditions: structuredClone(inputs.conditions), inputs: snapshot, benchmark, externalQuotes, rows, evidence, indicators: structuredClone(inputs.indicators),
    dataLabel: isSample ? "SAMPLE · 가상 협력사 견적·가상 외부 견적 기준" : "현재 협력사 자료·외부 완성부품 견적 기준", isSample,
    notes: ["신규 가상 협력사 견적은 기존 계약 단가·발주 이력과 다른 별도 자료이며 기존 평가점수 계산에는 반영하지 않습니다.", "시장 참고가격은 조건이 일치한 외부 완성부품 견적의 중앙값입니다. 등록 협력사 평균이나 원자재 가격이 아닙니다.", "평가점수는 기존 거래·운영 이력의 보조 정보이며 가격 보정계수나 단가 정당성의 근거로 쓰지 않습니다.", "관련 근거 문서의 조건을 확인해도 가격 차이의 원가 사유가 입증되는 것은 아닙니다. 최종 판단은 담당자입니다."],
  };
}

export function priceContextForRag(context: PriceAnalysis): PriceRagContext {
  return structuredClone({
    analysis_id: context.id, revision: context.revision, data_id: context.dataId, as_of: context.asOf,
    item: context.item, supplier_ids: context.supplierIds, conditions: context.conditions,
    supplier_quotes: context.rows.flatMap((row) => row.record ? [row.record] : []),
    external_quotes: context.externalQuotes.map(({ status: _status, statusLabel: _label, reasons: _reasons, checks: _checks, ...quote }) => quote),
    computed: { benchmark: context.benchmark, rows: context.rows.map(({ supplierId, supplierName, recordId, status, supplierPrice, benchmark, delta, deltaPct, reasons: why }) => ({ supplierId, supplierName, recordId, status, supplierPrice, benchmark, delta, deltaPct, reasons: why })) },
    evidence_ids: context.evidence.map((doc) => doc.id), indicators: context.indicators,
  });
}

const amount = (value: number | null) => value === null ? "계산 불가" : value.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
const signed = (value: number | null) => value === null ? "계산 불가" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(1)}%`;
export function priceAnalysisResult(context: PriceAnalysis, derived: Derived, question = "선택 품목의 협력사 단가를 시장 참고가격과 비교해줘."): AnalysisResult & { priceAnalysis: PriceAnalysis } {
  const median = context.benchmark.median;
  const rows = context.rows.map((row) => {
    const evaluation = derived.evaluations.get(row.supplierId);
    return {
      id: row.supplierId, label: row.supplierName, sub: row.supplierId, supplierId: row.supplierId, itemCode: row.itemCode,
      currency: row.record?.conditions.currency ?? context.conditions.currency ?? "KRW",
      values: { itemSpec: `${context.item.name} · ${row.record?.conditions.specification ?? context.item.spec ?? "규격 확인 필요"}`, supplierPrice: row.supplierPrice, benchmark: row.benchmark, delta: row.delta, deltaPct: row.deltaPct, status: row.statusLabel, reason: row.reasons.join(" · ") || "모든 비교 조건 일치", basisDate: row.record?.conditions.priceDate ?? null, priceBasis: row.record ? `${row.record.source.title} · ${row.record.source.documentId} · ${row.record.source.date}` : "가격 근거 확인 필요", total: evaluation?.total ?? null, grade: evaluation?.grade ?? null, evaluationPeriod: `${derived.windowFrom} ~ ${derived.asOf}` },
      strengths: row.status === "comparable" ? ["도면·재질·가공·검사·수량·가격 기준일·거래 조건 일치"] : [],
      risks: row.status === "comparable" ? ["가격 차이 사유 추가 확인: 품질·납기 점수만으로 높은 단가를 정당화하지 않습니다."] : row.reasons,
      evidence: [...row.evidence.map((doc) => `${doc.title} · ${doc.id} · ${doc.date}${doc.page ? ` · p.${doc.page}` : ""}: ${doc.text}`), `기존 평가 기간 ${derived.windowFrom} ~ ${derived.asOf} · 이 평가점수는 시장가격 보정에 사용하지 않습니다.`, ...(row.evidence.length ? [] : ["관련 근거를 찾지 못함"])],
      rank: null, ...(row.status !== "comparable" ? { excludedReason: row.reasons.join(" · ") } : {}),
    };
  });
  const comparable = context.rows.filter((row) => row.status === "comparable");
  const allReasons = unique(context.rows.flatMap((row) => row.reasons));
  return {
    id: context.id, params: { kind: "item_candidates", itemCode: context.item.itemCode, supplierIds: context.supplierIds }, kind: "item_candidates", kindLabel: "시장 참고가격 대비 비교", title: `${context.item.name} · 시장 참고가격 대비 비교`, question,
    purpose: "협력사 단가와 비교 가능한 외부 완성부품 견적의 차이, 비교 조건과 추가 확인 근거를 검토합니다.", createdAt: new Date().toISOString(), dataVersion: context.dataVersion, dataId: context.dataId, asOf: context.asOf, dataLabel: context.dataLabel,
    scope: [{ label: "선택 품목", value: `${context.item.name} · ${context.item.itemCode}` }, { label: "분석 기준일", value: context.asOf }, { label: "외부 가격 산정", value: `비교 가능 외부 견적 ${context.benchmark.count}건의 중앙값 · ${amount(median)} ${context.conditions.currency ?? "통화 미확인"}/${context.conditions.unit ?? "단위 미확인"}` }, { label: "외부 가격 범위", value: `${amount(context.benchmark.min)} ~ ${amount(context.benchmark.max)}` }, ...CONDITION_KEYS.map((key) => ({ label: PRICE_CONDITION_LABELS[key], value: missing(context.conditions[key]) ? "조건 확인 필요" : String(context.conditions[key]) })), { label: "기존 평가 기간", value: `${derived.windowFrom} ~ ${derived.asOf} · 거래·운영 이력(가격 보정에 사용하지 않음)` }],
    columns: [
      { key: "itemSpec", label: "품목·규격", kind: "text", primary: true }, { key: "supplierPrice", label: "협력사 단가", kind: "money", primary: true }, { key: "benchmark", label: "외부 시장 참고가격", kind: "money", primary: true },
      { key: "delta", label: "차액", kind: "money", primary: true }, { key: "deltaPct", label: "차이율", kind: "signedPercent", digits: 1, primary: true }, { key: "status", label: "비교 상태", kind: "status", primary: true },
      { key: "reason", label: "비교 제외·확인 필요 사유", kind: "text", primary: true }, { key: "basisDate", label: "가격 기준일", kind: "date", primary: true }, { key: "priceBasis", label: "가격 근거", kind: "text", primary: true },
      { key: "total", label: "기존 평가점수", kind: "number", digits: 1, unit: "점" }, { key: "grade", label: "기존 평가등급", kind: "grade" }, { key: "evaluationPeriod", label: "평가 기간·적용 범위", kind: "text" },
    ], rows, cardMetrics: ["supplierPrice", "benchmark", "deltaPct", "total"],
    highlights: [{ label: "가상 외부 견적 중앙값", value: amount(median) }, { label: "유효 외부 견적", value: `${context.benchmark.count}건` }, { label: "비교 가능", value: `${comparable.length}개 업체` }, { label: "제외·확인 필요", value: `${rows.length - comparable.length}개 업체` }],
    summary: [`선택 품목: ${context.item.name}(${context.item.itemCode}) · ${context.supplierIds.length}개 협력사.`, `시장 참고가격: 유효 외부 완성부품 견적 ${context.benchmark.count}건의 중앙값 ${amount(median)}, 범위 ${amount(context.benchmark.min)} ~ ${amount(context.benchmark.max)}.`, ...context.rows.map((row) => `${row.supplierName}: ${row.statusLabel} · 협력사 단가 ${amount(row.supplierPrice)} · 차액 ${amount(row.delta)} · 차이율 ${signed(row.deltaPct)}${row.reasons.length ? ` · ${row.reasons.join(" / ")}` : ""}`)],
    risks: allReasons, reviewPoints: ["가격이 높다는 이유만으로 부당한 가격이라고 단정하지 않습니다. 시장 참고가격 대비 차이와 가격 재검토 필요 여부를 담당자가 확인합니다.", "가격 차이의 원가 사유는 계약·견적 문서에 별도 기재된 근거가 있을 때만 설명합니다. 없으면 차이 사유 추가 확인으로 표시합니다."],
    basis: ["1. 선택 품목과 비교 대상: " + context.item.name, "2. 시장 참고가격: 조건이 일치한 외부 완성부품 견적의 중앙값", "3. 차액 = 협력사 단가 − 시장 참고가격; 차이율 = 차액 ÷ 시장 참고가격 × 100", "4. 누락 조건은 일치로 간주하지 않으며 불일치·제외 항목은 차액·차이율을 계산하지 않습니다.", ...context.evidence.map((doc) => `5. 문서 근거: ${doc.title} · ${doc.id} · ${doc.date}${doc.page ? ` · p.${doc.page}` : ""}`), "6. 추가 확인: 문서에 기재되지 않은 가격 차이 사유는 관련 근거를 찾지 못함으로 처리합니다."], notes: context.notes,
    sources: [{ table: "suppliers", label: "현재 등록 협력사", ids: context.supplierIds }, { table: "items", label: "현재 품목 마스터", ids: [context.item.itemCode] }, { table: "contracts", label: "현재 계약 원본(실제로 사용한 계약만)", ids: context.rows.flatMap((row) => row.record?.kind === "contract" ? [row.record.id] : []) }],
    charts: median !== null && comparable.length ? [{ id: "market-price-comparison", title: "협력사 단가와 외부 완성부품 시장 참고가격", type: "bar", unit: `${context.conditions.currency ?? "통화 미확인"}/${context.conditions.unit ?? "단위 미확인"}`, yLabel: "완성부품 단가", categories: comparable.map((row) => row.supplierName), series: [{ key: "supplierPrice", label: "협력사 단가", values: comparable.map((row) => row.supplierPrice) }, { key: "benchmark", label: "외부 견적 중앙값", values: comparable.map(() => median) }], caption: `현재 시점 가격 비교입니다. 과거 추이를 만들지 않습니다. 비교 제외·확인 필요 ${rows.length - comparable.length}개 업체는 차트에서 제외합니다.` }] : [],
    recommended: "table", templates: ["table", "chart", "cards", "report"], templateHints: { table: "차액·차이율과 비교 조건 확인", chart: "현재 시점의 비교 가능 가격만 표시", cards: "기존 평가점수는 보조 정보", report: "가격 차이와 조건·문서 근거 확인" }, priceAnalysis: context,
  };
}
