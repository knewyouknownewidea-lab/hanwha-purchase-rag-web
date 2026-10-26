// 왼쪽 데이터 관리: 4개 데이터 탭(하위 보기 포함) — 표, 검색·빠른 필터·상세 필터(부품 분류), 정렬, 행 상세, 업로드·엑셀
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { LuFileSpreadsheet, LuFileUp } from "react-icons/lu";
import { SUB_VIEWS, TAB_LABEL, halfLabel, type TabKey } from "../data/types";
import { useStore } from "../store/store";
import { DataTable, type Col } from "./DataTable";
import { FilterBar } from "./FilterBar";
import { FavStar } from "./FavStar";
import { GradeBadge, StatusPill } from "./ui";
import { PaymentSchedule } from "./subviews/PaymentSchedule";
import { MaterialPrices } from "./subviews/MaterialPrices";
import { LaborWages } from "./subviews/LaborWages";
import { CompetitorSupply } from "./subviews/CompetitorSupply";
import { IndustryNews } from "./subviews/IndustryNews";
import { fmtDate, fmtInt, fmtMoney, fmtNum, fmtPct, fmtSignedPct } from "../lib/format";
import type { ContractView, InventoryView, POView, SupplierView } from "../lib/metrics";
import { EVAL_CONFIG } from "../lib/evaluation";
import { applyFilters, uniqueOptions, type FilterDef, type Option } from "../lib/filters";
import { QUICK } from "../lib/kpi";
import { BOM_LEVELS, itemsUnder, optionsAt } from "../lib/bom";
import { buildXlsx, exportFileName, XLSX_MIME } from "../lib/xlsx";
import { infoSheet, tableSheet, type ExportCol } from "../lib/exporters";
import { saveFile, saveMessage } from "../platform/runtime";

const TABS: TabKey[] = ["suppliers", "purchaseOrders", "contracts", "inventory"];

const Code = ({ children }: { children: ReactNode }) => <span className="code">{children}</span>;
const NameCell = ({ name, code, star }: { name: string; code: string; star?: ReactNode }) => (
  <span className="name-cell-wrap">
    {star}
    <span className="name-cell">
      <span className="name">{name}</span>
      <Code>{code}</Code>
    </span>
  </span>
);

const matches = (q: string, ...fields: (string | number | null | undefined)[]) => {
  if (!q) return true;
  const t = fields.join(" ").toLowerCase().replace(/\s+/g, "");
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((tok) => t.includes(tok));
};

const GRADE_OPTS: Option[] = ["A", "B", "C", "D"].map((g) => ({ value: g, label: `${g}등급` }));
const PO_STATUS: Option[] = ["진행 중", "납기 지연", "지연입고", "입고완료", "취소"].map((v) => ({ value: v, label: v }));
const INV_STATUS: Option[] = ["정상", "안전재고 미달", "공급 지연", "미달·지연"].map((v) => ({ value: v, label: v }));


/** 열 정의 → 엑셀 열 (내보낼 값이 있는 열만) */
function exportCols<T>(cols: Col<T>[]): ExportCol<T>[] {
  return cols
    .filter((c) => c.exp || c.sort)
    .map((c) => ({
      header: c.label,
      kind: c.expKind ?? (c.date ? "date" : c.num ? "dec" : "text"),
      value: (r: T) => {
        const v = c.exp ? c.exp(r) : c.sort!(r);
        return v === undefined ? null : v;
      },
    }));
}

export function DataManagementTabs() {
  const { state, derived, dispatch } = useStore();
  const tab = state.tab;
  const sub = state.subView[tab] ?? "list";
  const q = state.queries[tab];
  const fv = state.filters[tab];
  const sel = state.selection;
  const selectedKey = sel.rowTab === tab ? sel.rowKey : null;
  const itemName = (code: string) => derived.itemsByCode.get(code)?.name ?? code;
  const asOf = state.meta.asOf;
  const month = asOf.slice(0, 7);
  const favSup = state.favorites.suppliers;
  const favItem = state.favorites.items;
  const rootRef = useRef<HTMLElement>(null);

  // 알림·관심 목록을 누르면 데이터 관리 영역으로 스크롤
  useEffect(() => {
    if (!state.focusTick) return;
    rootRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [state.focusTick]);

  // 검색 등으로 선택이 바뀌면 선택 행이 보이도록 스크롤
  useEffect(() => {
    if (!selectedKey) return;
    const t = setTimeout(() => document.querySelector(".data-table tr.is-selected")?.scrollIntoView({ block: "nearest" }), 60);
    return () => clearTimeout(t);
  }, [selectedKey, tab]);

  const counts: Record<TabKey, number> = {
    suppliers: derived.supplierViews.length,
    purchaseOrders: derived.poViews.length,
    contracts: derived.contractViews.length,
    inventory: derived.inventoryViews.length,
  };

  const itemOpts = useMemo(() => [...derived.itemsByCode.values()].map((i) => ({ value: i.itemCode, label: `${i.name} (${i.itemCode})` })), [derived]);
  const supOpts = useMemo(() => derived.supplierViews.map((s) => ({ value: s.supplierId, label: `${s.name} (${s.supplierId})` })), [derived]);


  // 부품 분류(엔진 > 대부품 > 중부품 > 소부품) 필터 — 모든 탭 공통
  const bomDef = useCallback(
    <T,>(itemsOf: (r: T) => string[]): FilterDef<T> => ({
      kind: "cascade",
      key: "bom",
      label: "부품 분류",
      levels: BOM_LEVELS,
      hint: "엔진 › 대부품 › 중부품 › 소부품 순서로 고르면 아래 단계가 좁혀집니다",
      options: (path, level) => optionsAt(derived.bomIndex, path, level, derived.itemsByCode),
      test: (r, path) => {
        const set = itemsUnder(derived.bomIndex, path);
        return itemsOf(r).some((c) => set.has(c));
      },
    }),
    [derived],
  );

  const view = useMemo(() => {
    if (tab === "suppliers") {
      const defs: FilterDef<SupplierView>[] = [
        { kind: "quick", key: "fav", label: "★ 관심만", test: (s) => favSup.includes(s.supplierId), hint: "별표로 고정한 관심 협력사" },
        { kind: "quick", key: "lowDelivery", label: `납기 ${EVAL_CONFIG.lowDeliveryThreshold}% 미만`, test: QUICK.lowDelivery, hint: "관리 기준(예시) 미만 업체" },
        { kind: "quick", key: "highDefect", label: "불량률 1.5% 이상", test: (s) => (s.defectRate ?? 0) >= 1.5 },
        { kind: "quick", key: "gradeCD", label: "C·D등급", test: QUICK.gradeCD, hint: "기준 미달 협력사 (평가등급 C·D)" },
        { kind: "quick", key: "missing", label: "평가 데이터 누락", test: (s) => (derived.evaluations.get(s.supplierId)?.missing.length ?? 0) > 0, hint: "평가 항목 입력값이 비어 있는 업체" },
        bomDef<SupplierView>((s) => s.items),
        { kind: "multi", key: "grade", label: "평가 등급", options: GRADE_OPTS, get: (s) => s.evalGrade },
        { kind: "range", key: "quality", label: "품질 점수", unit: "점", get: (s) => s.qualityScore ?? null },
        { kind: "below", key: "ontime", label: "납기 준수율", unit: "%", placeholder: "예: 95", get: (s) => s.onTimeRate },
        { kind: "range", key: "defect", label: "불량률", unit: "%", get: (s) => s.defectRate ?? null },
        { kind: "select", key: "process", label: "공정", options: uniqueOptions(derived.supplierViews.map((s) => s.process)), test: (s, v) => s.process === v },
        { kind: "select", key: "region", label: "지역", options: uniqueOptions(derived.supplierViews.map((s) => s.region)), test: (s, v) => s.region === v },
        { kind: "select", key: "item", label: "공급 품목", options: itemOpts, test: (s, v) => s.items.includes(v) },
      ];
      const base = derived.supplierViews.filter((s) => matches(q, s.name, s.supplierId, s.process, s.region, s.items.map(itemName).join(" "), s.items.join(" ")));
      const rows = applyFilters(base, defs, fv);
      const cols: Col<SupplierView>[] = [
        { key: "name", label: "협력사", render: (s) => <NameCell name={s.name} code={s.supplierId} star={<FavStar kind="suppliers" id={s.supplierId} name={s.name} />} />, sort: (s) => s.name, sticky: true, exp: (s) => `${s.name} (${s.supplierId})` },
        { key: "grade", label: "평가등급", hint: `종합 점수로 산정한 등급 (${EVAL_CONFIG.name})`, render: (s) => <GradeBadge grade={s.evalGrade} />, sort: (s) => s.evalGrade ?? "Z", exp: (s) => s.evalGrade },
        { key: "ontime", label: "납기 준수율", hint: "기한 내 입고 건 ÷ 마감된 발주 건 (납기 경과 미입고는 지연)", render: (s) => fmtPct(s.onTimeRate), sort: (s) => s.onTimeRate, num: true, expKind: "pct" },
        { key: "quality", label: "품질 점수", hint: "협력업체 시트의 품질 평가 점수(입고검사 기반, 100점)", render: (s) => fmtNum(s.qualityScore ?? null, 0), sort: (s) => s.qualityScore ?? null, num: true, expKind: "int" },
        { key: "defect", label: "불량률", hint: "입고검사 불량 비율(%)", render: (s) => fmtPct(s.defectRate ?? null), sort: (s) => s.defectRate ?? null, num: true, expKind: "pct" },
        { key: "trade", label: "최근 거래일", render: (s) => fmtDate(s.tradeDate), sort: (s) => s.tradeDate, date: true },
        { key: "items", label: "공급 가능 품목", render: (s) => <span className="clip">{s.items.map(itemName).join(", ") || "–"}</span>, sort: (s) => s.items.length, exp: (s) => s.items.map(itemName).join(", ") },
        { key: "hist", label: "평가 이력", hint: "최근 평가 3회 (상=상반기, 하=하반기)", render: (s) => (s.evalHistory.length ? s.evalHistory.slice(-3).map((h) => `${halfLabel(h, true)} ${h.grade}`).join(" · ") : "–"), exp: (s) => s.evalHistory.map((h) => `${halfLabel(h)} ${h.grade}(${h.score})`).join(" → ") },
      ];
      return { rows, cols, defs: defs as FilterDef<unknown>[], placeholder: "협력사명·업체ID·공정·품목으로 찾기", key: (s: SupplierView) => s.supplierId, pin: (s: SupplierView) => favSup.includes(s.supplierId), hasFav: favSup.length > 0 } as const;
    }
    if (tab === "purchaseOrders") {
      const defs: FilterDef<POView>[] = [
        { kind: "quick", key: "fav", label: "★ 관심만", test: (p) => favSup.includes(p.supplierId) || favItem.includes(p.itemCode), hint: "관심 협력사 또는 관심 부품의 발주" },
        { kind: "quick", key: "overdue", label: "납기 지연(미입고)", test: QUICK.overdue },
        { kind: "quick", key: "open", label: "진행 중만", test: (p) => p.status === "진행 중" },
        { kind: "quick", key: "thisMonth", label: `이번 달 납기 (${Number(month.slice(5))}월)`, test: (p) => p.dueDate.startsWith(month), hint: `데이터 기준일 ${asOf}의 달` },
        { kind: "quick", key: "lateRecv", label: "지연입고 이력", test: (p) => p.status === "지연입고" },
        bomDef<POView>((p) => [p.itemCode]),
        { kind: "multi", key: "status", label: "상태", options: PO_STATUS, get: (p) => p.status },
        { kind: "dateRange", key: "order", label: "발주일", get: (p) => p.orderDate },
        { kind: "dateRange", key: "due", label: "납기일", get: (p) => p.dueDate },
        { kind: "select", key: "sup", label: "발주 업체", options: supOpts, test: (p, v) => p.supplierId === v },
        { kind: "select", key: "item", label: "품목", options: itemOpts, test: (p, v) => p.itemCode === v },
      ];
      const base = derived.poViews.filter((p) => matches(q, p.poNo, p.itemName, p.itemCode, p.supplierName, p.supplierId, p.status));
      const rows = applyFilters(base, defs, fv);
      const cols: Col<POView>[] = [
        { key: "po", label: "발주번호", render: (p) => <Code>{p.poNo}</Code>, sort: (p) => p.poNo, sticky: true },
        { key: "item", label: "품목", render: (p) => <NameCell name={p.itemName} code={p.itemCode} />, sort: (p) => p.itemName },
        { key: "sup", label: "발주 업체", render: (p) => p.supplierName, sort: (p) => p.supplierName },
        { key: "status", label: "상태", hint: "납기 지연 = 납기가 지났는데 입고되지 않음", render: (p) => <StatusPill value={p.status} />, sort: (p) => p.status },
        { key: "due", label: "납기 예정일", render: (p) => p.dueDate, sort: (p) => p.dueDate, date: true },
        { key: "recv", label: "실제 입고일", render: (p) => fmtDate(p.receivedDate), sort: (p) => p.receivedDate, date: true },
        { key: "qty", label: "수량", render: (p) => fmtInt(p.qty), sort: (p) => p.qty, num: true, expKind: "int" },
        { key: "order", label: "발주 일자", render: (p) => p.orderDate, sort: (p) => p.orderDate, date: true },
      ];
      return { rows, cols, defs: defs as FilterDef<unknown>[], placeholder: "발주번호·품목·업체로 찾기", key: (p: POView) => p.poNo, initialSort: { key: "order", dir: "desc" as const }, pin: (p: POView) => favSup.includes(p.supplierId) || favItem.includes(p.itemCode), hasFav: favSup.length + favItem.length > 0 } as const;
    }
    if (tab === "contracts") {
      const th = EVAL_CONFIG.priceIncreaseThreshold;
      const defs: FilterDef<ContractView>[] = [
        { kind: "quick", key: "fav", label: "★ 관심만", test: (c) => favSup.includes(c.supplierId) || favItem.includes(c.itemCode), hint: "관심 협력사 또는 관심 부품의 계약" },
        { kind: "quick", key: "up", label: `${th}% 이상 상승`, test: QUICK.priceUp },
        { kind: "quick", key: "expiring", label: "60일 안에 종료", test: (c) => c.expiresInDays !== null && c.expiresInDays >= 0 && c.expiresInDays <= 60 },
        { kind: "quick", key: "foreign", label: "외화 계약", test: (c) => c.currency !== "KRW" },
        bomDef<ContractView>((c) => [c.itemCode]),
        { kind: "range", key: "chg", label: "단가 변동률", unit: "%", get: (c) => c.changeRate },
        { kind: "within", key: "exp", label: "계약 종료", unit: "일", get: (c) => c.expiresInDays },
        { kind: "select", key: "cur", label: "통화", options: uniqueOptions(derived.contractViews.map((c) => c.currency)), test: (c, v) => c.currency === v },
        { kind: "select", key: "sup", label: "거래 협력사", options: supOpts, test: (c, v) => c.supplierId === v },
        { kind: "select", key: "item", label: "품목", options: itemOpts, test: (c, v) => c.itemCode === v },
      ];
      const base = derived.contractViews.filter((c) => matches(q, c.contractId, c.itemName, c.itemCode, c.supplierName, c.supplierId, c.deliveryTerms, c.paymentTerms, c.currency));
      const rows = applyFilters(base, defs, fv);
      const cols: Col<ContractView>[] = [
        { key: "item", label: "품목", render: (c) => <NameCell name={c.itemName} code={c.itemCode} />, sort: (c) => c.itemName, sticky: true },
        { key: "sup", label: "거래 협력사", render: (c) => c.supplierName, sort: (c) => c.supplierName },
        { key: "price", label: "최근 단가", render: (c) => fmtMoney(c.unitPrice, c.currency), sort: (c) => c.unitPrice, num: true, expKind: "dec" },
        { key: "prev", label: "과거 단가", hint: "직전 계약 단가", render: (c) => fmtMoney(c.prevUnitPrice ?? null, c.currency), sort: (c) => c.prevUnitPrice ?? null, num: true, expKind: "dec" },
        {
          key: "chg",
          label: "변동률",
          hint: "(최근 단가 ÷ 과거 단가 − 1) × 100",
          render: (c) => <span className={(c.changeRate ?? 0) >= th ? "delta-up" : ""}>{fmtSignedPct(c.changeRate)}</span>,
          sort: (c) => c.changeRate,
          num: true,
          expKind: "pct",
        },
        { key: "term", label: "계약 기간", render: (c) => `${c.startDate ?? "–"} ~ ${c.endDate ?? "–"}`, sort: (c) => c.endDate, date: true, exp: (c) => `${c.startDate ?? ""} ~ ${c.endDate ?? ""}` },
        { key: "cond", label: "계약 조건", hint: "인도 조건 · 결제 조건", render: (c) => <span className="clip">{[c.deliveryTerms, c.paymentTerms].filter(Boolean).join(" · ")}</span>, exp: (c) => [c.deliveryTerms, c.paymentTerms].filter(Boolean).join(" · ") },
        { key: "cur", label: "통화", render: (c) => c.currency, sort: (c) => c.currency },
      ];
      return { rows, cols, defs: defs as FilterDef<unknown>[], placeholder: "계약번호·품목·업체·조건으로 찾기", key: (c: ContractView) => c.contractId, pin: (c: ContractView) => favSup.includes(c.supplierId) || favItem.includes(c.itemCode), hasFav: favSup.length + favItem.length > 0 } as const;
    }
    const defs: FilterDef<InventoryView>[] = [
      { kind: "quick", key: "fav", label: "★ 관심만", test: (v) => favItem.includes(v.itemCode), hint: "별표로 고정한 관심 부품" },
      { kind: "quick", key: "below", label: "안전재고 미달", test: QUICK.belowSafety },
      { kind: "quick", key: "delayed", label: "공급 지연", test: (v) => v.overdueOpen > 0, hint: "납기가 지났는데 입고되지 않은 발주가 있음" },
      { kind: "quick", key: "noOpen", label: "미달인데 발주 잔량 부족", test: (v) => v.shortage > 0 && v.openOrderQty < v.shortage },
      bomDef<InventoryView>((v) => [v.itemCode]),
      { kind: "multi", key: "status", label: "상태", options: INV_STATUS, get: (v) => v.status },
      { kind: "select", key: "sup", label: "공급 업체", options: supOpts, test: (v, x) => v.mainSupplierId === x },
    ];
    const base = derived.inventoryViews.filter((v) => matches(q, v.itemCode, v.itemName, v.supplierName, v.location, v.status));
    const rows = applyFilters(base, defs, fv);
    const cols: Col<InventoryView>[] = [
      { key: "name", label: "자재명", render: (v) => <NameCell name={v.itemName} code={v.itemCode} star={<FavStar kind="items" id={v.itemCode} name={v.itemName} />} />, sort: (v) => v.itemName, sticky: true, exp: (v) => `${v.itemName} (${v.itemCode})` },
      { key: "status", label: "공급 상태", hint: "안전재고 미달 = 현재 재고 < 안전재고 · 공급 지연 = 납기 지난 미입고 발주 있음", render: (v) => <StatusPill value={v.status} />, sort: (v) => v.status },
      { key: "stock", label: "현재 재고", render: (v) => fmtInt(v.stockQty), sort: (v) => v.stockQty, num: true, expKind: "int" },
      { key: "safe", label: "안전재고", render: (v) => fmtInt(v.safetyStock), sort: (v) => v.safetyStock, num: true, expKind: "int" },
      { key: "open", label: "발주 잔량", hint: "진행 중·납기 지연 발주 수량 합계", render: (v) => fmtInt(v.openOrderQty), sort: (v) => v.openOrderQty, num: true, expKind: "int" },
      { key: "exp", label: "예상 입고일", hint: "가장 빠른 미입고 발주의 납기 예정일", render: (v) => fmtDate(v.expectedDate), sort: (v) => v.expectedDate, date: true },
      { key: "sup", label: "공급 업체", render: (v) => v.supplierName, sort: (v) => v.supplierName },
      { key: "loc", label: "보관 위치", render: (v) => v.location ?? "–", sort: (v) => v.location ?? "" },
    ];
    return { rows, cols, defs: defs as FilterDef<unknown>[], placeholder: "품목코드·자재명·업체로 찾기", key: (v: InventoryView) => v.itemCode, pin: (v: InventoryView) => favItem.includes(v.itemCode), hasFav: favItem.length > 0 } as const;
  }, [tab, derived, q, fv, itemOpts, supOpts, month, asOf, favSup, favItem, bomDef]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSelect = (r: unknown) => {
    if (tab === "suppliers") {
      const s = r as SupplierView;
      dispatch({ type: "selectRow", tab, rowKey: s.supplierId, supplierId: s.supplierId });
    } else if (tab === "purchaseOrders") {
      const p = r as POView;
      dispatch({ type: "selectRow", tab, rowKey: p.poNo, supplierId: p.supplierId, itemCode: p.itemCode });
    } else if (tab === "contracts") {
      const c = r as ContractView;
      dispatch({ type: "selectRow", tab, rowKey: c.contractId, supplierId: c.supplierId, itemCode: c.itemCode });
    } else {
      const v = r as InventoryView;
      dispatch({ type: "selectRow", tab, rowKey: v.itemCode, itemCode: v.itemCode, supplierId: v.mainSupplierId ?? undefined });
    }
    dispatch({ type: "panel", panel: "C" }); // 상세는 오른쪽 분석 결과창에 (태블릿·휴대폰은 결과 탭으로 전환)
  };

  const exportExcel = async () => {
    const label = TAB_LABEL[tab];
    const sheet = tableSheet(label, exportCols(view.cols as Col<unknown>[]), view.rows as unknown[]);
    const info = infoSheet([
      ["데이터", label],
      ["조건", q ? `검색: ${q}` : "검색 없음"],
      ["행 수", `${view.rows.length} / 전체 ${counts[tab]}`],
      ["데이터 기준일", asOf],
      ["출처", state.meta.sources[tab] ?? "–"],
      ["표기", state.meta.isSample ? "SAMPLE · 시연용 가상 데이터" : state.meta.label],
      ["내보낸 사람", state.user.name],
      ["내보낸 시각", new Date().toLocaleString("ko-KR")],
    ]);
    const bytes = buildXlsx([sheet, info], `${label} 데이터`);
    const r = await saveFile(exportFileName("데이터", label), bytes, XLSX_MIME);
    dispatch({ type: "toast", text: saveMessage(r, `${label} ${view.rows.length}행 엑셀 파일`), tone: r === "saved" ? "ok" : "warn" });
  };

  const subviews = SUB_VIEWS[tab];
  const filtering = !!q || view.defs.some((d) => fv[d.key] !== undefined);
  const pinned = state.pinFav && view.hasFav ? (view.pin as (r: unknown) => boolean) : undefined;

  return (
    <section className="data-tabs" aria-label="데이터 관리" ref={rootRef}>
      <div className="tabs" role="tablist" aria-label="데이터 종류">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" id={`tab-${t}`} aria-selected={tab === t} aria-controls="tab-panel" className={`tab ${tab === t ? "is-active" : ""}`} onClick={() => dispatch({ type: "tab", tab: t })}>
            <span className="tab-label">{TAB_LABEL[t]}</span>
            <span className="tab-count">{counts[t]}</span>
          </button>
        ))}
      </div>
      {subviews.length > 1 && (
        <div className="subtabs" role="tablist" aria-label={`${TAB_LABEL[tab]} 보기`}>
          {subviews.map((v) => (
            <button key={v.id} type="button" role="tab" aria-selected={sub === v.id} className={`subtab ${sub === v.id ? "is-on" : ""}`} onClick={() => dispatch({ type: "subView", tab, view: v.id })} data-sub={v.id}>
              {v.label}
              {v.id === "payments" && derived.payments.summary["임박"].count > 0 && <span className="subtab-badge">{derived.payments.summary["임박"].count}</span>}
            </button>
          ))}
        </div>
      )}
      {sub === "payments" ? (
        <PaymentSchedule />
      ) : sub === "materials" ? (
        <MaterialPrices />
      ) : sub === "wages" ? (
        <LaborWages />
      ) : sub === "competitors" ? (
        <CompetitorSupply />
      ) : sub === "news" ? (
        <IndustryNews />
      ) : (
        <>
          <FilterBar
            key={tab}
            id={tab}
            defs={view.defs}
            values={fv}
            onChange={(v) => dispatch({ type: "filters", tab, values: v })}
            query={q}
            onQuery={(v) => dispatch({ type: "query", tab, q: v })}
            placeholder={view.placeholder}
            shown={view.rows.length}
            total={counts[tab]}
            actions={
              <>
                <button type="button" className="btn btn-quiet" onClick={() => dispatch({ type: "openImport", dataset: tab })} title={`${TAB_LABEL[tab]} 데이터 파일(CSV·JSON) 불러오기 — 빈 양식도 받을 수 있습니다`}>
                  <LuFileUp aria-hidden /> 불러오기
                </button>
                <button type="button" className="btn btn-quiet" onClick={exportExcel} disabled={!view.rows.length} title="지금 조건에 맞는 행을 엑셀(.xlsx)로 내보내기" data-export="xlsx">
                  <LuFileSpreadsheet aria-hidden /> 엑셀<span className="hide-xs"> 내보내기</span>
                </button>
              </>
            }
            extra={
              view.hasFav ? (
                <label className="check-inline" title="별표로 고정한 관심 항목을 표 맨 위에 둡니다">
                  <input type="checkbox" checked={state.pinFav} onChange={(e) => dispatch({ type: "pinFav", on: e.target.checked })} id="pin-fav" />
                  <span>관심 항목 맨 위</span>
                </label>
              ) : null
            }
          />
          <div id="tab-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
            <DataTable
              key={tab}
              label={`${TAB_LABEL[tab]} 표`}
              rows={view.rows as unknown[]}
              cols={view.cols as Col<unknown>[]}
              rowKey={view.key as (r: unknown) => string}
              selectedKey={selectedKey}
              onSelect={onSelect}
              pinned={pinned}
              initialSort={"initialSort" in view ? view.initialSort : undefined}
              empty={filtering ? "조건에 맞는 행이 없습니다. 조건 칩의 ×를 누르거나 ‘전체 초기화’를 눌러 보세요." : "데이터가 없습니다. ‘불러오기’로 파일을 올리거나 오른쪽 위 ‘샘플 데이터로 되돌리기’를 눌러 보세요."}
            />
          </div>
          <p className="data-source">
            출처 {state.meta.sources[tab] ?? "–"} · 기준일 {asOf} · 행을 누르면 오른쪽 분석 결과창에 상세가 열리고, AI 질문의 대상(문맥)으로 쓰입니다
          </p>
        </>
      )}
    </section>
  );
}
