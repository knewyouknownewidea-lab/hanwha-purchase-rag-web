import assert from "node:assert/strict";
import test from "node:test";
import { loadSample } from "../src/data/sampleData";
import { createPriceSample, PRICE_SAMPLE_CONDITIONS } from "../src/data/priceSample";
import { derive } from "../src/lib/metrics";
import { buildPriceAnalysis, checkPriceConditions, isPriceDate, medianValidPrices, normalizePriceInputs, priceAnalysisResult, priceContextForRag, updateExternalQuote, type PriceConditions } from "../src/lib/priceComparison";

const make = () => {
  const { data, meta } = loadSample();
  const inputs = createPriceSample(data, meta);
  const analyze = (value = inputs) => buildPriceAnalysis(data, meta, value, { itemCode: "ITM-1001" });
  return { data, meta, inputs, analyze };
};
const rowBy = (context: ReturnType<typeof buildPriceAnalysis>, supplier = "SUP-001") => context.rows.find((row) => row.supplierId === supplier)!;
const allNull = (rows: ReturnType<typeof buildPriceAnalysis>["rows"]) => rows.every((row) => row.delta === null && row.deltaPct === null);

test("SAMPLE external median and strictly comparable supplier amounts", () => {
  const { analyze } = make();
  const context = analyze();
  assert.deepEqual(context.benchmark, { median: 1000000, count: 3, min: 980000, max: 1020000, usedQuoteIds: ["EXT-LINER-001", "EXT-LINER-002", "EXT-LINER-003"], status: "comparable", reasons: [] });
  assert.deepEqual(context.rows.map((row) => [row.supplierPrice, row.delta, row.deltaPct, row.status]), [[1120000, 120000, 12, "comparable"], [1050000, 50000, 5, "comparable"], [980000, -20000, -2, "comparable"], [1090000, null, null, "excluded"]]);
  assert.match(rowBy(context, "SUP-004").reasons.join(" "), /검사 조건 차이/);
  assert.equal(context.evidence.length, 7);
});

test("external quote edit recalculates every price result without changing historical evaluation", () => {
  const { data, meta, inputs, analyze } = make();
  const original = structuredClone(data);
  const evaluation = derive(data, meta.asOf);
  const before = structuredClone([...evaluation.evaluations]);
  const changed = updateExternalQuote(inputs, "EXT-LINER-002", 1040000);
  assert.notEqual(changed.revision, inputs.revision);
  assert.equal(inputs.externalQuotes[1].unitPrice, 1000000);
  assert.equal(updateExternalQuote(changed, "EXT-LINER-002", 1040000), changed);
  assert.throws(() => updateExternalQuote(inputs, "missing", 100));
  const context = analyze(changed);
  const result = priceAnalysisResult(context, evaluation);
  assert.equal(context.benchmark.median, 1020000);
  assert.equal(rowBy(context).delta, 100000);
  assert.equal(rowBy(context).deltaPct, 100000 / 1020000 * 100);
  assert.equal(rowBy(context, "SUP-003").delta, -40000);
  assert.deepEqual(result.templates, ["table", "chart", "cards", "report"]);
  for (const row of result.rows) {
    const domain = rowBy(context, row.supplierId);
    assert.equal(row.values.benchmark, 1020000);
    assert.equal(row.values.delta, domain.delta);
    assert.equal(row.values.deltaPct, domain.deltaPct);
    assert.equal(row.rank, null);
    assert.equal(row.values.total, evaluation.evaluations.get(row.supplierId!)?.total);
    assert.equal(row.values.grade, evaluation.evaluations.get(row.supplierId!)?.grade);
  }
  assert.equal(result.charts[0].type, "bar");
  assert.deepEqual(result.charts[0].series[1].values, [1020000, 1020000, 1020000]);
  assert.equal(result.charts[0].categories.length, 3);
  assert.deepEqual([...evaluation.evaluations], before);
  assert.deepEqual(derive(data, meta.asOf).evaluations, evaluation.evaluations);
  assert.deepEqual(data, original);
  assert.equal(data.contracts[0].unitPrice, 1250000);
  assert.equal(rowBy(context).supplierPrice, 1120000);
  assert.deepEqual(context.inputs.indicators, inputs.indicators);
  assert.equal(context.evidence.length, 7, "editable amounts do not invalidate condition evidence");
});

test("every missing comparison condition needs confirmation and every mismatch excludes", () => {
  const { inputs, analyze } = make();
  for (const key of Object.keys(PRICE_SAMPLE_CONDITIONS) as (keyof PriceConditions)[]) {
    const absent = structuredClone(inputs);
    delete absent.supplierQuotes[0].conditions[key];
    const missing = rowBy(analyze(absent));
    assert.equal(missing.status, "needs_confirmation", key);
    assert.equal(missing.deltaPct, null, key);
    assert.equal(missing.delta, null, key);
    const mismatch = structuredClone(inputs);
    if (key === "quantity") mismatch.supplierQuotes[0].conditions[key] = 11;
    else if (key === "priceDate") mismatch.supplierQuotes[0].conditions[key] = "2026-10-14";
    else if (key === "currency") mismatch.supplierQuotes[0].conditions[key] = "USD";
    else mismatch.supplierQuotes[0].conditions[key] = "different";
    const excluded = rowBy(analyze(mismatch));
    assert.equal(excluded.status, "excluded", key);
    assert.equal(excluded.deltaPct, null, key);
    assert.equal(excluded.delta, null, key);
  }
});

test("exclusion depends on condition differences rather than supplier name or ID", () => {
  const { data, meta, inputs } = make();
  data.suppliers[3].name = "조건이 다른 협력사(가상)";
  inputs.supplierQuotes[3].conditions.inspection = inputs.conditions.inspection;
  inputs.supplierQuotes[0].conditions.inspection = "검사 미실시";
  const context = buildPriceAnalysis(data, meta, inputs, { itemCode: "ITM-1001" });
  assert.equal(rowBy(context).status, "excluded");
  assert.equal(rowBy(context, "SUP-004").status, "comparable");
  assert.equal(rowBy(context, "SUP-004").supplierName, "조건이 다른 협력사(가상)");
  assert.equal(rowBy(context, "SUP-004").deltaPct, 9);
});

test("invalid, missing and zero prices never enter median or calculated differences", () => {
  const { inputs, analyze } = make();
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    const next = structuredClone(inputs);
    next.supplierQuotes[0].unitPrice = invalid;
    next.externalQuotes[0].unitPrice = invalid;
    const context = analyze(next);
    assert.equal(rowBy(context).status, "excluded");
    assert.equal(rowBy(context).supplierPrice, null);
    assert.equal(rowBy(context).deltaPct, null);
    assert.equal(context.externalQuotes[0].status, "excluded");
    assert.equal(context.benchmark.count, 2);
    assert.equal(context.benchmark.median, 1010000);
  }
  inputs.supplierQuotes[0].unitPrice = null;
  assert.equal(rowBy(analyze()).status, "needs_confirmation");
  assert.equal(rowBy(analyze()).deltaPct, null);
  assert.equal(medianValidPrices([0, -1, Number.NaN, Infinity, null, undefined]), null);
  assert.equal(medianValidPrices([5, 1, 3]), 3);
  assert.equal(medianValidPrices([5, 1, 3, 2]), 2.5);
});

test("empty or unusable external evidence leaves all benchmark values and differences null", () => {
  const { inputs, analyze } = make();
  for (const prices of [[], [0, Number.NaN, null]]) {
    const next = structuredClone(inputs);
    next.externalQuotes = next.externalQuotes.slice(0, prices.length).map((quote, i) => ({ ...quote, unitPrice: prices[i] }));
    const context = analyze(next);
    assert.equal(context.benchmark.count, 0);
    assert.equal(context.benchmark.median, null);
    assert.equal(context.benchmark.min, null);
    assert.equal(context.benchmark.max, null);
    assert.ok(allNull(context.rows));
    assert.equal(rowBy(context).status, "needs_confirmation");
    assert.equal(rowBy(context, "SUP-004").status, "excluded");
  }
});

test("zero percent is valid only for a comparable price that equals the benchmark", () => {
  const { inputs, analyze } = make();
  inputs.supplierQuotes[0].unitPrice = 1000000;
  assert.equal(rowBy(analyze()).deltaPct, 0);
  inputs.supplierQuotes[0].conditions.inspection = null;
  assert.equal(rowBy(analyze()).deltaPct, null);
});

test("extremely small positive benchmark cannot create non-finite calculated values", () => {
  const { inputs, analyze } = make();
  inputs.externalQuotes.forEach((quote) => { quote.unitPrice = 1e-310; });
  const context = analyze();
  assert.equal(context.benchmark.median, 1e-310);
  assert.equal(rowBy(context).status, "excluded");
  assert.ok(allNull(context.rows));
  assert.match(rowBy(context).reasons.join(" "), /유한한 수치/);
});

test("dates, quantity, currency and units are strict and never silently converted", () => {
  assert.ok(isPriceDate("2024-02-29"));
  for (const value of ["2026-02-29", "2026-13-01", "2026-10-32", "2026-1-01", "0000-01-01", "2026-10-15T00:00:00Z", "", null]) assert.equal(isPriceDate(value), false);
  const { inputs, data, meta, analyze } = make();
  const invalids: PriceConditions[] = [{ quantity: 0 }, { quantity: Number.NaN }, { quantity: Infinity }, { currency: "krw" }, { priceDate: "2026-02-30" }];
  for (const change of invalids) {
    const next = structuredClone(inputs);
    Object.assign(next.supplierQuotes[0].conditions, change);
    assert.equal(rowBy(analyze(next)).status, "excluded");
  }
  for (const date of ["2026-10-14", "2026-10-16", "invalid"]) {
    const context = buildPriceAnalysis(data, meta, inputs, { itemCode: "ITM-1001", asOf: date });
    assert.equal(context.benchmark.median, null);
    assert.ok(allNull(context.rows));
  }
  const next = structuredClone(inputs);
  next.supplierQuotes[0].conditions.unit = "SET";
  next.supplierQuotes[1].conditions.currency = "USD";
  assert.equal(rowBy(analyze(next)).status, "excluded");
  assert.equal(rowBy(analyze(next), "SUP-002").status, "excluded");
});

test("duplicate external IDs, mixed item records and wrong record kinds are excluded", () => {
  const { inputs, analyze } = make();
  inputs.externalQuotes[1].id = inputs.externalQuotes[0].id;
  let context = analyze();
  assert.equal(context.benchmark.count, 1);
  assert.equal(context.benchmark.median, 1020000);
  assert.equal(context.externalQuotes[0].status, "excluded");
  assert.equal(context.externalQuotes[1].status, "excluded");
  inputs.externalQuotes[2].conditions.itemCode = "ITM-1002";
  context = analyze();
  assert.equal(context.benchmark.count, 0);
  const other = make();
  (other.inputs.externalQuotes[0] as { kind: string }).kind = "supplier_quote";
  assert.equal(other.analyze().externalQuotes[0].status, "excluded");
});

test("commodity indicators and supplier average cannot become the finished part benchmark", () => {
  const { inputs, analyze } = make();
  inputs.supplierQuotes.forEach((quote) => { quote.unitPrice = 5000000; });
  inputs.indicators = inputs.indicators.map((indicator) => ({ ...indicator, status: "connected", value: 99999999, source: "테스트", isSample: true }));
  const context = analyze();
  assert.equal(context.benchmark.median, 1000000);
  assert.equal(rowBy(context).deltaPct, 400);
  assert.equal(context.indicators[0].value, 99999999);
});

test("document evidence joins by record, supplier, item and unchanged conditions", () => {
  const { inputs, analyze } = make();
  const row = () => rowBy(analyze());
  assert.deepEqual(row().evidence.map((doc) => doc.id), ["PRICE-INT-A"]);
  inputs.evidence[0].supplierIds = ["SUP-002"];
  assert.deepEqual(row().evidence, []);
  inputs.evidence[0].supplierIds = ["SUP-001"];
  inputs.evidence[0].recordIds = ["INT-LINER-B"];
  assert.deepEqual(row().evidence, []);
  inputs.evidence[0].recordIds = ["INT-LINER-A"];
  inputs.evidence[0].itemCode = "ITM-1002";
  assert.deepEqual(row().evidence, []);
  inputs.evidence[0].itemCode = "ITM-1001";
  inputs.supplierQuotes[0].conditions.inspection = "다른 검사";
  assert.deepEqual(row().evidence, []);
  inputs.evidence = [];
  assert.deepEqual(analyze().evidence, []);
  assert.equal(row().status, "excluded");
});

test("missing source and conflicting document dates cannot pass comparability", () => {
  const { inputs, analyze } = make();
  inputs.supplierQuotes[0].source.title = "";
  assert.equal(rowBy(analyze()).status, "needs_confirmation");
  inputs.supplierQuotes[0].source.title = "가상 견적 조건서";
  inputs.supplierQuotes[0].source.date = "2026-10-14";
  assert.equal(rowBy(analyze()).status, "excluded");
  inputs.supplierQuotes[0].source.date = "2026-13-14";
  assert.equal(rowBy(analyze()).status, "excluded");
});

test("conflicting evidence title or page cannot silently join a document with the same ID", () => {
  const { inputs, analyze } = make();
  inputs.supplierQuotes[0].source.title = "다른 문서";
  assert.deepEqual(rowBy(analyze()).evidence, []);
  inputs.supplierQuotes[0].source.title = inputs.evidence[0].title;
  inputs.supplierQuotes[0].source.page = "2";
  assert.deepEqual(rowBy(analyze()).evidence, []);
  inputs.supplierQuotes[0].source.page = "1";
  assert.equal(rowBy(analyze()).evidence.length, 1);
});

test("uploaded current contracts are read live without injecting SAMPLE quotes or unknown terms", () => {
  const { data, meta } = loadSample();
  meta.isSample = false;
  meta.dataId = "upload-a";
  const inputs = createPriceSample(data, meta);
  assert.deepEqual(inputs.externalQuotes, []);
  assert.deepEqual(inputs.supplierQuotes, []);
  assert.deepEqual(inputs.evidence, []);
  data.contracts[0].unitPrice = 2222222;
  const context = buildPriceAnalysis(data, meta, inputs, { itemCode: "ITM-1001" });
  assert.equal(rowBy(context).supplierPrice, 2222222);
  assert.equal(rowBy(context).record?.kind, "contract");
  assert.equal(rowBy(context).status, "needs_confirmation");
  assert.equal(context.benchmark.median, null);
  assert.equal(context.isSample, false);
});

test("stale dataset snapshots cannot reuse previous sidecar supplier or external prices", () => {
  const { data, meta, inputs } = make();
  meta.dataId = "different-upload";
  const context = buildPriceAnalysis(data, meta, inputs, { itemCode: "ITM-1001" });
  assert.equal(rowBy(context).recordId, data.contracts[0].contractId);
  assert.equal(rowBy(context).supplierPrice, 1250000);
  assert.equal(context.benchmark.median, null);
  assert.ok(allNull(context.rows));
  assert.match(rowBy(context).reasons.join(" "), /이전 웹 데이터/);
});

test("supplier selection and current names are shared with RAG context", () => {
  const { data, meta, inputs } = make();
  data.suppliers[0].name = "변경한 현재 이름(가상)";
  const context = buildPriceAnalysis(data, meta, inputs, { itemCode: "ITM-1001", supplierIds: ["SUP-001", "SUP-004"] });
  const wire = priceContextForRag(context);
  assert.deepEqual(wire.supplier_ids, ["SUP-001", "SUP-004"]);
  assert.equal(wire.computed.rows[0].supplierName, "변경한 현재 이름(가상)");
  assert.equal(wire.analysis_id, context.id);
  assert.equal(wire.revision, inputs.revision);
  assert.equal(wire.computed.rows[0].deltaPct, 12);
  assert.equal(wire.computed.rows[1].deltaPct, null);
  assert.equal(wire.supplier_quotes.length, 2);
  assert.equal(wire.external_quotes.length, 3);
  assert.equal("status" in wire.external_quotes[0], false);
  assert.deepEqual(wire.indicators, context.indicators);
  wire.indicators[0].message = "changed snapshot";
  assert.notEqual(context.indicators[0].message, "changed snapshot");
  wire.conditions.material = "changed";
  assert.notEqual(context.conditions.material, "changed");
  assert.throws(() => buildPriceAnalysis(data, meta, inputs, { itemCode: "missing" }));
});

test("all view columns preserve null exclusion values and original scores without rank", () => {
  const { data, meta, analyze } = make();
  const derived = derive(data, meta.asOf);
  const result = priceAnalysisResult(analyze(), derived);
  for (const key of ["itemSpec", "supplierPrice", "benchmark", "delta", "deltaPct", "status", "reason", "basisDate"]) assert.equal(result.columns.find((column) => column.key === key)?.primary, true, key);
  const d = result.rows.find((row) => row.supplierId === "SUP-004")!;
  assert.equal(d.values.delta, null);
  assert.equal(d.values.deltaPct, null);
  assert.equal(d.rank, null);
  assert.match(d.excludedReason!, /검사 조건 차이/);
  assert.equal(d.values.total, derived.evaluations.get("SUP-004")!.total);
  assert.equal(result.charts.length, 1);
  assert.equal(result.charts[0].type, "bar");
  assert.ok(result.sources.find((source) => source.table === "contracts")!.ids.length === 0);
  assert.ok(result.summary.some((line) => line.includes(data.suppliers[0].name) && line.includes("12.0%")));
  assert.ok(result.notes.some((line) => line.includes("최종 판단은 담당자")));
});

test("storage normalization preserves unknown comparisons but rejects malformed shape", () => {
  const { inputs } = make();
  const normalized = normalizePriceInputs(inputs)!;
  assert.deepEqual(normalized, inputs);
  normalized.supplierQuotes[0].unitPrice = 1;
  assert.equal(inputs.supplierQuotes[0].unitPrice, 1120000);
  inputs.supplierQuotes[0].unitPrice = 0;
  inputs.supplierQuotes[0].conditions.material = null;
  assert.ok(normalizePriceInputs(inputs));
  const malformed: unknown[] = [null, [], {}, { ...inputs, asOf: "bad" }, { ...inputs, revision: "x".repeat(129) }, { ...inputs, conditions: { ...inputs.conditions, arbitrary: "ignored" } }, { ...inputs, externalQuotes: new Array(101).fill(inputs.externalQuotes[0]) }, { ...inputs, supplierQuotes: [{ ...inputs.supplierQuotes[0], unitPrice: "1120000" }] }];
  for (const value of malformed) assert.equal(normalizePriceInputs(value), null);
});

test("comparison calculation never mutates its current dataset, inputs or evaluation map", () => {
  const { data, meta, inputs } = make();
  const original = structuredClone({ data, meta, inputs });
  const deepFreeze = (value: object) => { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child); };
  const derived = derive(data, meta.asOf);
  const scores = structuredClone([...derived.evaluations]);
  deepFreeze(data); deepFreeze(meta); deepFreeze(inputs);
  priceAnalysisResult(buildPriceAnalysis(data, meta, inputs, { itemCode: "ITM-1001" }), derived);
  assert.deepEqual({ data, meta, inputs }, original);
  assert.deepEqual([...derived.evaluations], scores);
});

test("condition matching tolerates incidental whitespace only", () => {
  const condition = structuredClone(PRICE_SAMPLE_CONDITIONS);
  condition.material = "  특수주철  ";
  assert.ok(checkPriceConditions(PRICE_SAMPLE_CONDITIONS, condition).every((check) => check.status === "comparable"));
  condition.material = "특수 강";
  assert.ok(checkPriceConditions(PRICE_SAMPLE_CONDITIONS, condition).some((check) => check.status === "excluded"));
  const missingBoth: PriceConditions = {};
  assert.ok(checkPriceConditions(missingBoth, missingBoth).every((check) => check.status === "needs_confirmation"));
});
