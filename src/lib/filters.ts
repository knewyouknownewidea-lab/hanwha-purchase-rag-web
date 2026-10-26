// 데이터 탭 필터: 조건 정의 → 적용 → 적용 중인 조건 칩 문구
export interface Option {
  value: string;
  label: string;
}

export type FilterDef<T> =
  | { kind: "quick"; key: string; label: string; test: (r: T) => boolean; hint?: string }
  | { kind: "multi"; key: string; label: string; options: Option[]; get: (r: T) => string | null | undefined }
  | { kind: "range"; key: string; label: string; unit?: string; get: (r: T) => number | null | undefined }
  | { kind: "below"; key: string; label: string; unit?: string; placeholder?: string; get: (r: T) => number | null | undefined }
  | { kind: "within"; key: string; label: string; unit: string; get: (r: T) => number | null | undefined }
  | { kind: "select"; key: string; label: string; options: Option[]; test: (r: T, v: string) => boolean }
  | { kind: "dateRange"; key: string; label: string; get: (r: T) => string | null | undefined }
  /** 단계별로 좁혀 고르는 필터 (예: 엔진 > 대부품 > 중부품 > 소부품). 값은 고른 경로 배열 */
  | { kind: "cascade"; key: string; label: string; levels: readonly string[]; options: (path: string[], level: number) => Option[]; test: (r: T, path: string[]) => boolean; hint?: string };

export type Range = { min?: number | null; max?: number | null };
export type DateRange = { from?: string; to?: string };
export type FilterValues = Record<string, unknown>;

const num = (v: unknown) => (v === "" || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

export function isActive<T>(def: FilterDef<T>, v: unknown): boolean {
  switch (def.kind) {
    case "quick":
      return v === true;
    case "multi":
      return Array.isArray(v) && v.length > 0;
    case "range": {
      const r = (v || {}) as Range;
      return num(r.min) !== null || num(r.max) !== null;
    }
    case "below":
    case "within":
      return num(v) !== null;
    case "select":
      return typeof v === "string" && v !== "";
    case "dateRange": {
      const r = (v || {}) as DateRange;
      return !!(r.from || r.to);
    }
    case "cascade":
      return Array.isArray(v) && v.some(Boolean);
  }
}

function pass<T>(def: FilterDef<T>, v: unknown, row: T): boolean {
  switch (def.kind) {
    case "quick":
      return def.test(row);
    case "multi": {
      const x = def.get(row);
      return x !== null && x !== undefined && (v as string[]).includes(x);
    }
    case "range": {
      const x = def.get(row);
      if (x === null || x === undefined) return false;
      const r = v as Range;
      const lo = num(r.min);
      const hi = num(r.max);
      return (lo === null || x >= lo) && (hi === null || x <= hi);
    }
    case "below": {
      const x = def.get(row);
      return x !== null && x !== undefined && x < (num(v) as number);
    }
    case "within": {
      const x = def.get(row);
      return x !== null && x !== undefined && x >= 0 && x <= (num(v) as number);
    }
    case "select":
      return def.test(row, v as string);
    case "dateRange": {
      const x = def.get(row);
      if (!x) return false;
      const r = v as DateRange;
      return (!r.from || x >= r.from) && (!r.to || x <= r.to);
    }
    case "cascade":
      return def.test(row, v as string[]);
  }
}

export function applyFilters<T>(rows: T[], defs: FilterDef<T>[], values: FilterValues): T[] {
  const active = defs.filter((d) => isActive(d, values[d.key]));
  if (!active.length) return rows;
  return rows.filter((r) => active.every((d) => pass(d, values[d.key], r)));
}

export function chipText<T>(def: FilterDef<T>, v: unknown): string {
  const u = "unit" in def && def.unit ? def.unit : "";
  switch (def.kind) {
    case "quick":
      return def.label;
    case "multi":
      return `${def.label}: ${(v as string[]).map((x) => def.options.find((o) => o.value === x)?.label ?? x).join(", ")}`;
    case "range": {
      const r = v as Range;
      const lo = num(r.min);
      const hi = num(r.max);
      if (lo !== null && hi !== null) return `${def.label} ${lo}~${hi}${u}`;
      return lo !== null ? `${def.label} ${lo}${u} 이상` : `${def.label} ${hi}${u} 이하`;
    }
    case "below":
      return `${def.label} ${num(v)}${u} 미만`;
    case "within":
      return `${def.label} ${num(v)}${u} 이내`;
    case "select":
      return `${def.label}: ${def.options.find((o) => o.value === v)?.label ?? v}`;
    case "dateRange": {
      const r = v as DateRange;
      return `${def.label} ${r.from || "처음"} ~ ${r.to || "끝"}`;
    }
    case "cascade":
      return `${def.label}: ${(v as string[]).filter(Boolean).join(" › ")}`;
  }
}

export const uniqueOptions = (values: (string | null | undefined)[]): Option[] =>
  Array.from(new Set(values.filter((v): v is string => !!v)))
    .sort((a, b) => a.localeCompare(b, "ko"))
    .map((v) => ({ value: v, label: v }));
