// 대금 결제 일정: 발주(입고일·납기 예정일) + 계약 결제조건 → 결제 예정일
// 지급 실적 데이터가 없으므로 "지급 완료"나 "지연"으로 판단하지 않는다.
// 지원하는 결제조건 형식은 이 파일의 parseTerms 한 곳에서만 정의한다.
import type { Contract } from "../data/types";
import type { POView } from "./metrics";
import { daysBetween } from "./format";

export const PAYMENT_RULE = {
  imminentDays: 7, // 결제 예정일까지 7일 이내 → 임박
  upcomingDays: 30, // 30일 이내 → 예정
  recentPastDays: 14, // 예정일이 지난 지 14일 이내 → 지급 확인 필요
  horizonWeeks: 12, // 주별 그래프 기간
  unresolvedWindowDays: 90, // 결제조건을 해석하지 못한 발주는 최근 90일 이내 입고·납기분만 표시
};

export const SUPPORTED_TERMS = [
  "월말 마감 N일 — 입고한 달의 말일 + N일",
  "월말 마감 익월 D일 — 입고한 다음 달 D일",
  "입고 후 N일 · 검수 후 N일 — 입고일 + N일",
];

export type TermParse =
  | { ok: true; kind: "monthEndPlus"; days: number }
  | { ok: true; kind: "monthEndNextDay"; day: number }
  | { ok: true; kind: "afterReceipt"; days: number }
  | { ok: false; reason: string };

export function parseTerms(t: string | null | undefined): TermParse {
  if (!t || !t.trim()) return { ok: false, reason: "결제조건 없음" };
  const s = t.replace(/\s+/g, " ").trim();
  let m = s.match(/^월말\s*마감\s*익월\s*(\d{1,2})\s*일$/);
  if (m) {
    const day = Number(m[1]);
    if (day >= 1 && day <= 31) return { ok: true, kind: "monthEndNextDay", day };
  }
  m = s.match(/^월말\s*마감\s*(?:후\s*)?(\d{1,3})\s*일$/);
  if (m) return { ok: true, kind: "monthEndPlus", days: Number(m[1]) };
  m = s.match(/^(?:입고|검수)\s*(?:후|기준)\s*(\d{1,3})\s*일$/);
  if (m) return { ok: true, kind: "afterReceipt", days: Number(m[1]) };
  if (/선적/.test(s)) return { ok: false, reason: "선적일 데이터가 없어 날짜를 계산하지 않음" };
  return { ok: false, reason: "해석할 수 없는 결제조건" };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (s: string) => new Date(s + "T00:00:00Z");

export function addDays(date: string, n: number) {
  const d = utc(date);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

export function monthEnd(date: string) {
  const d = utc(date);
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

/** 결제 예정일 계산 (기준일 = 입고일 또는 납기 예정일) */
export function payDateOf(basis: string, p: Extract<TermParse, { ok: true }>): string {
  if (p.kind === "afterReceipt") return addDays(basis, p.days);
  if (p.kind === "monthEndPlus") return addDays(monthEnd(basis), p.days);
  const d = utc(basis);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1; // 다음 달
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(y, mo, Math.min(p.day, last))));
}

export type PayStatus = "지급 확인 필요" | "임박" | "예정" | "이후" | "조건 확인 필요" | "입고 대기";

export interface PaymentRow {
  poNo: string;
  supplierId: string;
  supplierName: string;
  itemCode: string;
  itemName: string;
  qty: number;
  amount: number | null;
  currency: string;
  terms: string;
  basis: "입고 확정" | "납기 예정" | "–";
  basisDate: string | null;
  payDate: string | null;
  dday: number | null;
  status: PayStatus;
  note?: string;
}

export interface PaymentSummaryCell {
  count: number;
  amounts: Record<string, number>;
}

export interface PaymentSchedule {
  rows: PaymentRow[];
  hiddenPast: number;
  summary: Record<PayStatus, PaymentSummaryCell>;
  weeks: { label: string; from: string; to: string; amounts: Record<string, number> }[];
  currencies: string[];
}

const STATUSES: PayStatus[] = ["지급 확인 필요", "임박", "예정", "이후", "조건 확인 필요", "입고 대기"];

export function statusOf(dday: number): PayStatus | null {
  if (dday < -PAYMENT_RULE.recentPastDays) return null;
  if (dday < 0) return "지급 확인 필요";
  if (dday <= PAYMENT_RULE.imminentDays) return "임박";
  if (dday <= PAYMENT_RULE.upcomingDays) return "예정";
  return "이후";
}

/** 같은 업체·품목의 계약 중 가장 늦게 끝나는 계약의 결제조건을 쓴다 */
function contractIndex(contracts: Contract[]) {
  const map = new Map<string, Contract>();
  for (const c of contracts) {
    const k = `${c.supplierId}|${c.itemCode}`;
    const prev = map.get(k);
    if (!prev || (c.endDate ?? "") > (prev.endDate ?? "")) map.set(k, c);
  }
  return map;
}

export function buildPayments(poViews: POView[], contracts: Contract[], asOf: string): PaymentSchedule {
  const idx = contractIndex(contracts);
  const rows: PaymentRow[] = [];
  let hiddenPast = 0;
  for (const p of poViews) {
    if (p.status === "취소") continue;
    const c = idx.get(`${p.supplierId}|${p.itemCode}`);
    const amount = p.unitPrice === null || p.unitPrice === undefined ? null : p.qty * p.unitPrice;
    const base = {
      poNo: p.poNo,
      supplierId: p.supplierId,
      supplierName: p.supplierName,
      itemCode: p.itemCode,
      itemName: p.itemName,
      qty: p.qty,
      amount,
      currency: p.currency,
      terms: c?.paymentTerms?.trim() || "–",
    };
    if (p.status === "납기 지연") {
      rows.push({ ...base, basis: "–", basisDate: null, payDate: null, dday: null, status: "입고 대기", note: "납기가 지났지만 입고되지 않아 결제 예정일을 정할 수 없음" });
      continue;
    }
    const received = !!p.receivedDate;
    const basisDate = (p.receivedDate || p.dueDate) as string;
    const basis = received ? "입고 확정" : "납기 예정";
    const parsed = c ? parseTerms(c.paymentTerms) : ({ ok: false, reason: "연결된 계약 없음 (결제조건 없음)" } as const);
    if (!parsed.ok) {
      const age = daysBetween(basisDate, asOf);
      if (age > PAYMENT_RULE.unresolvedWindowDays) {
        hiddenPast++;
        continue;
      }
      rows.push({ ...base, basis, basisDate, payDate: null, dday: null, status: "조건 확인 필요", note: parsed.reason });
      continue;
    }
    const payDate = payDateOf(basisDate, parsed);
    const dday = daysBetween(asOf, payDate);
    const status = statusOf(dday);
    if (!status) {
      hiddenPast++;
      continue;
    }
    rows.push({ ...base, basis, basisDate, payDate, dday, status });
  }
  rows.sort((a, b) => {
    const sa = STATUSES.indexOf(a.status);
    const sb = STATUSES.indexOf(b.status);
    if (a.payDate && b.payDate) return a.payDate.localeCompare(b.payDate) || a.poNo.localeCompare(b.poNo);
    if (a.payDate) return -1;
    if (b.payDate) return 1;
    return sa - sb || a.poNo.localeCompare(b.poNo);
  });

  const summary = Object.fromEntries(STATUSES.map((s) => [s, { count: 0, amounts: {} as Record<string, number> }])) as Record<PayStatus, PaymentSummaryCell>;
  for (const r of rows) {
    const cell = summary[r.status];
    cell.count++;
    if (r.amount !== null) cell.amounts[r.currency] = (cell.amounts[r.currency] ?? 0) + r.amount;
  }

  const weeks: PaymentSchedule["weeks"] = [];
  for (let i = 0; i < PAYMENT_RULE.horizonWeeks; i++) {
    const from = addDays(asOf, i * 7);
    const to = addDays(asOf, i * 7 + 6);
    const amounts: Record<string, number> = {};
    for (const r of rows) {
      if (!r.payDate || r.amount === null || r.payDate < from || r.payDate > to) continue;
      amounts[r.currency] = (amounts[r.currency] ?? 0) + r.amount;
    }
    weeks.push({ label: `${Number(from.slice(5, 7))}/${Number(from.slice(8, 10))}~`, from, to, amounts });
  }
  const currencies = Array.from(new Set(rows.filter((r) => r.payDate && r.amount !== null).map((r) => r.currency))).sort((a, b) => (a === "KRW" ? -1 : b === "KRW" ? 1 : a.localeCompare(b)));
  return { rows, hiddenPast, summary, weeks, currencies };
}

/** 헤더 알림에 쓰는 건수: 임박 + 지급 확인 필요 (담당자가 '확인함' 표시한 건 제외) */
export function alertCount(s: PaymentSchedule, checked: string[]) {
  const set = new Set(checked);
  return s.rows.filter((r) => (r.status === "임박" || r.status === "지급 확인 필요") && !set.has(r.poNo)).length;
}
