// 원자재 시세·인건비 지표: 원화(원/kg) 환산, 전월·전년 대비, 3개월 추세, 직종 분류 트리
import type { FxRate, LaborWage, MaterialPrice } from "../data/types";
import { round } from "./format";

export const MARKET_RULE = {
  displayUnit: "원/kg",
  trendMonths: 3,
};

const pct = (a: number | null | undefined, b: number | null | undefined) => (a === null || a === undefined || b === null || b === undefined || b === 0 ? null : round((a / b - 1) * 100, 1));

export function shiftMonth(month: string, n: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export interface MaterialSeries {
  material: string;
  months: string[];
  intlKrw: (number | null)[]; // 국제 시세 원/kg 환산
  intlRaw: (number | null)[]; // 국제 시세 원래 값
  intlUnit: string; // 예: USD/톤
  domestic: (number | null)[]; // 국내 시세 원/kg
  latestMonth: string | null;
  latest: { intl: number | null; domestic: number | null };
  mom: { intl: number | null; domestic: number | null };
  yoy: { intl: number | null; domestic: number | null };
  trend3: { intl: number | null; domestic: number | null };
  notes: string[];
}

/** 원/kg로 바꾼다. 환율이 필요한데 없으면 null */
export function toKrwPerKg(p: Pick<MaterialPrice, "price" | "unit" | "currency" | "month">, fx: Map<string, number>): number | null {
  const unit = (p.unit || "").replace(/\s/g, "").toLowerCase();
  const perKg = unit === "kg" ? 1 : unit === "톤" || unit === "t" || unit === "ton" || unit === "mt" ? 1 / 1000 : null;
  if (perKg === null) return null;
  const cur = (p.currency || "KRW").toUpperCase();
  const rate = cur === "KRW" ? 1 : fx.get(`${p.month}|${cur}`) ?? null;
  if (rate === null) return null;
  return p.price * rate * perKg;
}

export function fxIndex(fx: FxRate[]) {
  return new Map(fx.map((f) => [`${f.month}|${(f.currency || "USD").toUpperCase()}`, f.krw]));
}

export function buildMaterialSeries(prices: MaterialPrice[], fx: FxRate[]): MaterialSeries[] {
  const fxMap = fxIndex(fx);
  const byMat = new Map<string, MaterialPrice[]>();
  for (const p of prices) {
    if (!byMat.has(p.material)) byMat.set(p.material, []);
    byMat.get(p.material)!.push(p);
  }
  const out: MaterialSeries[] = [];
  for (const [material, rows] of byMat) {
    const months = Array.from(new Set(rows.map((r) => r.month))).sort();
    const notes: string[] = [];
    const intlRows = new Map(rows.filter((r) => r.market === "국제").map((r) => [r.month, r]));
    const domRows = new Map(rows.filter((r) => r.market === "국내").map((r) => [r.month, r]));
    const intlKrw = months.map((m) => {
      const r = intlRows.get(m);
      if (!r) return null;
      const v = toKrwPerKg(r, fxMap);
      if (v === null && !notes.includes("환율 데이터가 없는 달은 국제 시세를 환산하지 않았습니다")) notes.push("환율 데이터가 없는 달은 국제 시세를 환산하지 않았습니다");
      return v === null ? null : round(v, 0);
    });
    const intlRaw = months.map((m) => intlRows.get(m)?.price ?? null);
    const domestic = months.map((m) => {
      const r = domRows.get(m);
      if (!r) return null;
      const v = toKrwPerKg(r, fxMap);
      return v === null ? null : round(v, 0);
    });
    const anyIntl = [...intlRows.values()][0];
    const last = months.length - 1;
    const at = (arr: (number | null)[], i: number) => (i >= 0 && i < arr.length ? arr[i] : null);
    out.push({
      material,
      months,
      intlKrw,
      intlRaw,
      intlUnit: anyIntl ? `${anyIntl.currency}/${anyIntl.unit}` : "–",
      domestic,
      latestMonth: months[last] ?? null,
      latest: { intl: at(intlKrw, last), domestic: at(domestic, last) },
      mom: { intl: pct(at(intlKrw, last), at(intlKrw, last - 1)), domestic: pct(at(domestic, last), at(domestic, last - 1)) },
      yoy: { intl: pct(at(intlKrw, last), at(intlKrw, last - 12)), domestic: pct(at(domestic, last), at(domestic, last - 12)) },
      trend3: { intl: pct(at(intlKrw, last), at(intlKrw, last - MARKET_RULE.trendMonths)), domestic: pct(at(domestic, last), at(domestic, last - MARKET_RULE.trendMonths)) },
      notes,
    });
  }
  return out;
}

// ── 인건비 ──
export interface WageNode {
  level: 0 | 1 | 2; // 대·중·소
  name: string;
  path: string[];
  months: string[];
  series: (number | null)[]; // 하위 분류 평균(원/월)
  latest: number | null;
  yoy: number | null;
  children: WageNode[];
}

function avgSeries(nodes: WageNode[], months: string[]): (number | null)[] {
  return months.map((_, i) => {
    const vals = nodes.map((n) => n.series[i]).filter((v): v is number => v !== null);
    return vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length, 0) : null;
  });
}

function finish(n: Omit<WageNode, "latest" | "yoy">): WageNode {
  const last = n.series.length - 1;
  const latest = last >= 0 ? n.series[last] : null;
  return { ...n, latest, yoy: pct(latest, last - 12 >= 0 ? n.series[last - 12] : null) };
}

export function buildWageTree(rows: LaborWage[]): { roots: WageNode[]; months: string[]; byMinor: Map<string, WageNode> } {
  const months = Array.from(new Set(rows.map((r) => r.month))).sort();
  const mi = new Map(months.map((m, i) => [m, i]));
  const tree = new Map<string, Map<string, Map<string, (number | null)[]>>>();
  for (const r of rows) {
    if (!tree.has(r.major)) tree.set(r.major, new Map());
    const mids = tree.get(r.major)!;
    if (!mids.has(r.mid)) mids.set(r.mid, new Map());
    const minors = mids.get(r.mid)!;
    if (!minors.has(r.minor)) minors.set(r.minor, months.map(() => null));
    minors.get(r.minor)![mi.get(r.month)!] = r.wage;
  }
  const byMinor = new Map<string, WageNode>();
  const roots: WageNode[] = [];
  for (const [major, mids] of tree) {
    const midNodes: WageNode[] = [];
    for (const [mid, minors] of mids) {
      const minorNodes = [...minors].map(([minor, series]) => {
        const node = finish({ level: 2, name: minor, path: [major, mid, minor], months, series, children: [] });
        byMinor.set(minor, node);
        return node;
      });
      midNodes.push(finish({ level: 1, name: mid, path: [major, mid], months, series: avgSeries(minorNodes, months), children: minorNodes }));
    }
    roots.push(finish({ level: 0, name: major, path: [major], months, series: avgSeries(midNodes, months), children: midNodes }));
  }
  return { roots, months, byMinor };
}

export function findNode(roots: WageNode[], path: string[]): WageNode | null {
  let level: WageNode[] = roots;
  let found: WageNode | null = null;
  for (const p of path) {
    found = level.find((n) => n.name === p) ?? null;
    if (!found) return null;
    level = found.children;
  }
  return found;
}

/** 협력사 공정 → 관련 직종(소분류). 공정 이름에 들어 있는 낱말로 연결한다. */
export const PROCESS_TO_JOBS: [string, string[]][] = [
  ["주조", ["주조원"]],
  ["단조", ["단조원", "열처리 조작원"]],
  ["가공", ["CNC 공작기계 조작원", "연삭·정밀가공 조작원"]],
  ["배관", ["배관원", "용접원"]],
  ["소모품", ["프레스·판금 조작원"]],
  ["용접", ["용접원"]],
  ["도장", ["도장기 조작원"]],
  ["조립", ["엔진·기계 조립원"]],
];

export function jobsForProcess(process: string | null | undefined): string[] {
  if (!process) return [];
  const out: string[] = [];
  for (const [kw, jobs] of PROCESS_TO_JOBS) if (process.includes(kw)) for (const j of jobs) if (!out.includes(j)) out.push(j);
  return out;
}
