// 구매조달 › 대금 결제 일정: 입고일(또는 납기 예정일) + 결제조건 → 결제 예정일, 7일 이내 임박 · 30일 이내 예정
import { useMemo, useState } from "react";
import { LuCircleCheck, LuInfo } from "react-icons/lu";
import { useStore } from "../../store/store";
import { DataTable, type Col } from "../DataTable";
import { Chart } from "../charts/Chart";
import { StatusPill } from "../ui";
import { FavStar } from "../FavStar";
import type { ChartSpec } from "../../lib/analysisTypes";
import { fmtMoney } from "../../lib/format";
import { PAYMENT_RULE, SUPPORTED_TERMS, type PayStatus, type PaymentRow } from "../../lib/payments";
import { SubViewHead } from "./SubViewHead";

const CARDS: { status: PayStatus; label: string; hint: string }[] = [
  { status: "임박", label: `임박 (${PAYMENT_RULE.imminentDays}일 이내)`, hint: `결제 예정일까지 ${PAYMENT_RULE.imminentDays}일 이내` },
  { status: "예정", label: `예정 (${PAYMENT_RULE.upcomingDays}일 이내)`, hint: `결제 예정일까지 ${PAYMENT_RULE.imminentDays + 1}~${PAYMENT_RULE.upcomingDays}일` },
  { status: "지급 확인 필요", label: "지급 확인 필요", hint: `결제 예정일이 지난 지 ${PAYMENT_RULE.recentPastDays}일 이내 — 지급 실적 데이터가 없어 실제 지급 여부를 확인해야 합니다` },
  { status: "이후", label: `${PAYMENT_RULE.upcomingDays}일 이후`, hint: "결제 예정일이 한 달 넘게 남은 건" },
  { status: "조건 확인 필요", label: "결제조건 확인 필요", hint: "결제조건을 해석할 수 없거나 계약이 연결되지 않아 날짜를 계산하지 않은 건" },
  { status: "입고 대기", label: "입고 대기 (납기 지연)", hint: "납기가 지났는데 입고되지 않아 결제 예정일을 정할 수 없는 건" },
];

const money = (amounts: Record<string, number>) =>
  Object.keys(amounts).length
    ? Object.entries(amounts)
        .map(([c, v]) => fmtMoney(v, c))
        .join(" + ")
    : "–";

export function PaymentSchedule() {
  const { state, derived, dispatch } = useStore();
  const s = derived.payments;
  const [status, setStatus] = useState<PayStatus | "all">("all");
  const checked = useMemo(() => new Set(state.payChecked), [state.payChecked]);
  const favSup = state.favorites.suppliers;

  const rows = useMemo(() => (status === "all" ? s.rows : s.rows.filter((r) => r.status === status)), [s.rows, status]);
  const charts: ChartSpec[] = s.currencies.map((cur) => ({
    id: `pay-${cur}`,
    title: `앞으로 ${PAYMENT_RULE.horizonWeeks}주 주별 결제 예정 금액${s.currencies.length > 1 ? ` (${cur})` : ""}`,
    type: "bar",
    unit: cur === "KRW" ? "원" : cur,
    yLabel: cur === "KRW" ? "결제 예정 금액(원)" : `결제 예정 금액(${cur})`,
    xLabel: "주 (시작일)",
    categories: s.weeks.map((w) => w.label),
    series: [{ key: cur, label: "결제 예정 금액", values: s.weeks.map((w) => w.amounts[cur] ?? 0) }],
    statusOf: s.weeks.map((_, i) => (i === 0 ? "critical" : null)),
    statusLabel: `빨간 막대 = 오늘(기준일 ${state.meta.asOf})부터 ${PAYMENT_RULE.imminentDays}일, 임박 구간 · 점선 = 오늘`,
    xMarker: { index: 0, label: "오늘" },
    caption: "통화별로 따로 합계하며 환율로 합치지 않습니다. 날짜를 계산하지 못한 건(결제조건 확인 필요·입고 대기)은 그래프에 넣지 않습니다.",
    digits: 0,
  }));

  const cols: Col<PaymentRow>[] = [
    {
      key: "dday",
      label: "D-day",
      render: (r) => (r.dday === null ? <span className="muted">–</span> : <span className={`dday ${r.status === "임박" ? "is-hot" : r.dday < 0 ? "is-past" : ""}`}>{r.dday === 0 ? "D-day" : r.dday > 0 ? `D-${r.dday}` : `D+${-r.dday}`}</span>),
      sort: (r) => r.dday,
      num: true,
      exp: (r) => r.dday,
      expKind: "int",
      hint: "결제 예정일까지 남은 날 (D+는 지난 날)",
    },
    { key: "pay", label: "결제 예정일", render: (r) => r.payDate ?? "–", sort: (r) => r.payDate, date: true, exp: (r) => r.payDate, expKind: "date" },
    { key: "status", label: "상태", render: (r) => <StatusPill value={r.status} />, sort: (r) => r.status, exp: (r) => r.status },
    {
      key: "sup",
      label: "업체",
      render: (r) => (
        <span className="cell-fav">
          {favSup.includes(r.supplierId) && <FavStar kind="suppliers" id={r.supplierId} name={r.supplierName} />}
          {r.supplierName}
        </span>
      ),
      sort: (r) => r.supplierName,
      exp: (r) => r.supplierName,
    },
    { key: "po", label: "발주번호", render: (r) => <span className="code">{r.poNo}</span>, sort: (r) => r.poNo, exp: (r) => r.poNo },
    { key: "item", label: "품목", render: (r) => r.itemName, sort: (r) => r.itemName, exp: (r) => r.itemName },
    { key: "amt", label: "금액", hint: "발주 수량 × 발주 단가", render: (r) => fmtMoney(r.amount, r.currency), sort: (r) => r.amount, num: true, exp: (r) => r.amount, expKind: "int" },
    {
      key: "terms",
      label: "결제조건",
      // 날짜를 계산하지 못한 이유를 결제조건 바로 아래에 보여 준다 (마우스를 올리지 않아도 보이게)
      render: (r) =>
        r.status === "조건 확인 필요" ? (
          <span className="terms-cell">
            <span className="clip" title={r.terms}>
              {r.terms}
            </span>
            <span className="cell-why">{r.note}</span>
          </span>
        ) : (
          <span className="clip" title={r.terms}>
            {r.terms}
          </span>
        ),
      sort: (r) => r.terms,
      exp: (r) => (r.status === "조건 확인 필요" && r.note ? `${r.terms} (${r.note})` : r.terms),
    },
    { key: "basis", label: "기준", hint: "입고 확정 = 실제 입고일 기준, 납기 예정 = 아직 입고 전이라 납기 예정일 기준", render: (r) => (r.basis === "–" ? <span className="muted">{r.note}</span> : `${r.basis} ${r.basisDate}`), sort: (r) => r.basisDate, exp: (r) => (r.basis === "–" ? r.note ?? "" : `${r.basis} ${r.basisDate}`) },
    {
      key: "chk",
      label: "확인",
      hint: "담당자가 확인했다는 표시(이 브라우저에 저장). 실제 지급 완료 처리가 아닙니다.",
      render: (r) =>
        r.payDate ? (
          <label className="check-inline" title="확인했다는 표시만 남깁니다 (지급 완료 처리 아님)">
            <input type="checkbox" checked={checked.has(r.poNo)} onChange={(e) => dispatch({ type: "payCheck", poNo: r.poNo, on: e.target.checked })} aria-label={`${r.poNo} 확인함`} />
            <span>{checked.has(r.poNo) ? "확인함" : "확인"}</span>
          </label>
        ) : null,
      exp: (r) => (checked.has(r.poNo) ? "확인함" : ""),
    },
  ];

  return (
    <section className="subview" aria-label="대금 결제 일정">
      <SubViewHead title="대금 결제 일정" desc="입고일(입고 전이면 납기 예정일)에 계약 결제조건을 적용해 결제 예정일을 계산합니다. 지급 실적 데이터가 없으므로 지급 완료·지연은 판단하지 않습니다." datasets={["purchaseOrders", "contracts"]} asOf={state.meta.asOf} />
      <div className="pay-cards" role="group" aria-label="결제 상태별 요약 (누르면 목록 거르기)">
        {CARDS.map((c) => {
          const cell = s.summary[c.status];
          const on = status === c.status;
          return (
            <button key={c.status} type="button" className={`pay-card tone-${c.status === "임박" ? "hot" : c.status === "예정" ? "info" : c.status === "지급 확인 필요" || c.status === "조건 확인 필요" ? "warn" : "muted"} ${on ? "is-on" : ""}`} aria-pressed={on} onClick={() => setStatus(on ? "all" : c.status)} title={c.hint} data-pay={c.status}>
              <span className="pay-card-label">{c.label}</span>
              <span className="pay-card-count">
                {cell.count}
                <small>건</small>
              </span>
              <span className="pay-card-amt">{money(cell.amounts)}</span>
            </button>
          );
        })}
      </div>
      {charts.map((c) => (
        <Chart key={c.id} spec={c} />
      ))}
      <div className="sv-list-head">
        <h4>
          결제 예정 목록 {status !== "all" && <span className="fchip fchip-static">{status}</span>}
          <span className="muted"> {rows.length}건</span>
        </h4>
        {status !== "all" && (
          <button type="button" className="link-btn" onClick={() => setStatus("all")}>
            전체 보기
          </button>
        )}
      </div>
      <DataTable key={status} id="pay-table" label="결제 예정 목록" rows={rows} cols={cols} rowKey={(r) => r.poNo} initialSort={null} empty="이 상태의 결제 예정 건이 없습니다." />
      <div className="sv-notes">
        <p>
          <LuInfo aria-hidden /> 계산할 수 있는 결제조건: {SUPPORTED_TERMS.join(" · ")}. 그 밖의 조건(예: 선적 후 N일 — 선적일 데이터 없음, 분할 결제)은 날짜를 추정하지 않고 ‘결제조건 확인 필요’로 표시합니다.
        </p>
        <p>
          <LuCircleCheck aria-hidden /> 결제 예정일이 기준일보다 {PAYMENT_RULE.recentPastDays}일 넘게 지난 {s.hiddenPast.toLocaleString()}건(과거 결제분)은 표시하지 않습니다. 결제조건은 현재 계약 기준입니다.
        </p>
      </div>
    </section>
  );
}
