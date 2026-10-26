// 업로드 데이터 검증: 헤더 매핑 → 형식 변환 → 필수값·범위·중복·참조 검사
import { SCHEMAS, pkOf, type FieldDef } from "../data/schema";
import type { DataSet, DatasetKey, EvalHistoryEntry, Grade } from "../data/types";

export interface Issue {
  row: number; // 1부터 시작하는 데이터 행 번호
  field?: string;
  message: string;
}

export interface ValidationResult<T = Record<string, unknown>> {
  dataset: DatasetKey;
  rows: T[];
  total: number;
  errors: Issue[];
  warnings: Issue[];
  mapped: { source: string; field: string; label: string }[];
  unmapped: string[];
  missingRequired: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-()·.\/%]/g, "");

export function mapHeaders(dataset: DatasetKey, headers: string[]) {
  const schema = SCHEMAS[dataset];
  const map = new Map<string, FieldDef>();
  const mapped: { source: string; field: string; label: string }[] = [];
  const unmapped: string[] = [];
  const used = new Set<string>();
  for (const h of headers) {
    const n = norm(h);
    const def = schema.fields.find(
      (f) => !used.has(f.key) && (norm(f.key) === n || norm(f.label) === n || (f.aliases || []).some((a) => norm(a) === n)),
    );
    if (def) {
      map.set(h, def);
      used.add(def.key);
      mapped.push({ source: h, field: def.key, label: def.label });
    } else unmapped.push(h);
  }
  const missingRequired = schema.fields.filter((f) => f.required && !used.has(f.key)).map((f) => f.label);
  return { map, mapped, unmapped, missingRequired };
}

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

export function parseNumber(v: unknown): number | null | undefined {
  if (isBlank(v)) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const s = String(v).replace(/[,\s원%]/g, "").replace(/^₩/, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function parseDate(v: unknown): string | null | undefined {
  if (isBlank(v)) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4})[-./년\s]+(\d{1,2})[-./월\s]+(\d{1,2})일?$/);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined;
  return dt.toISOString().slice(0, 10);
}

export function parseMonth(v: unknown): string | null | undefined {
  if (isBlank(v)) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4})[-./년\s]+(\d{1,2})(?:[-./월\s]+(\d{1,2})일?)?\s*월?$/);
  if (!m) return undefined;
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return undefined;
  return `${m[1]}-${String(mo).padStart(2, "0")}`;
}

function parseGrade(v: unknown): Grade | null | undefined {
  if (isBlank(v)) return null;
  const s = String(v).trim().toUpperCase().replace("등급", "");
  return ["A", "B", "C", "D"].includes(s) ? (s as Grade) : undefined;
}

function parseList(v: unknown): string[] {
  if (isBlank(v)) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v)
    .split(/[;,|\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseBool(v: unknown): boolean | undefined {
  if (isBlank(v)) return false;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "y", "yes", "1", "예", "취소", "o"].includes(s)) return true;
  if (["false", "n", "no", "0", "아니오", "x", "정상"].includes(s)) return false;
  return undefined;
}

/** "2025H1", "2025 하반기", "2025-2", "2024" → { year, half } */
function parsePeriod(v: unknown): { year: number; half: 1 | 2 | null } | undefined {
  const t = String(v ?? "").trim();
  const m = t.match(/^(\d{4})\s*(?:[-_./ ]?\s*(h1|h2|상반기|하반기|상|하|1|2))?$/i);
  if (!m) return undefined;
  const h = (m[2] || "").toLowerCase();
  const half = h === "h1" || h === "상반기" || h === "상" || h === "1" ? 1 : h === "h2" || h === "하반기" || h === "하" || h === "2" ? 2 : null;
  return { year: Number(m[1]), half };
}

function parseHistory(v: unknown): EvalHistoryEntry[] | undefined {
  if (isBlank(v)) return [];
  if (Array.isArray(v)) {
    const out: EvalHistoryEntry[] = [];
    for (const e of v) {
      const o = e as Record<string, unknown>;
      const g = parseGrade(o.grade);
      const y = parseNumber(o.year);
      const sc = parseNumber(o.score);
      if (!g || !y || sc === undefined || sc === null) return undefined;
      const half = o.half === 1 || o.half === 2 ? (o.half as 1 | 2) : null;
      out.push({ year: y, half, grade: g, score: sc, reason: typeof o.reason === "string" && o.reason.trim() ? o.reason.trim() : null });
    }
    return out;
  }
  const out: EvalHistoryEntry[] = [];
  for (const part of String(v).split(/[;|]/)) {
    if (!part.trim()) continue;
    const [p, g, sc, ...rest] = part.split(":").map((x) => x.trim());
    const period = parsePeriod(p);
    const grade = parseGrade(g);
    if (!period || !grade || !sc || Number.isNaN(Number(sc))) return undefined;
    const reason = rest.join(":").trim();
    out.push({ year: period.year, half: period.half, grade, score: Number(sc), reason: reason || null });
  }
  return out;
}

export function validateRows(
  dataset: DatasetKey,
  rawRows: Record<string, unknown>[],
  refs?: Pick<DataSet, "items" | "suppliers">,
): ValidationResult {
  const schema = SCHEMAS[dataset];
  const headers = Array.from(new Set(rawRows.flatMap((r) => Object.keys(r))));
  const { map, mapped, unmapped, missingRequired } = mapHeaders(dataset, headers);
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const itemSet = refs ? new Set(refs.items.map((i) => i.itemCode)) : null;
  const supSet = refs ? new Set(refs.suppliers.map((s) => s.supplierId)) : null;

  if (missingRequired.length) {
    errors.push({ row: 0, message: `필수 열이 없습니다: ${missingRequired.join(", ")} → 첫 줄의 열 이름을 확인하거나 '빈 양식 받기'로 받은 양식에 옮겨 적어 주세요` });
    return { dataset, rows, total: rawRows.length, errors, warnings, mapped, unmapped, missingRequired };
  }

  rawRows.forEach((raw, idx) => {
    const rowNo = idx + 1;
    const out: Record<string, unknown> = {};
    let ok = true;
    const errCount = errors.length;
    const badFields = new Set<string>(); // 형식 오류가 난 열은 '필수값 비어 있음'을 또 내지 않는다
    for (const [src, def] of map) {
      const v = raw[src];
      let val: unknown;
      switch (def.type) {
        case "number": {
          const n = parseNumber(v);
          if (n === undefined) {
            errors.push({ row: rowNo, field: def.label, message: `숫자가 아닙니다 (${String(v)}) → 숫자만 적어 주세요 (예: 85, 1.5)` });
            ok = false;
          } else if (n !== null && ((def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max))) {
            errors.push({ row: rowNo, field: def.label, message: `허용 범위(${def.min ?? "-"}~${def.max ?? "-"})를 벗어났습니다 (${n}) → 단위(%, 점)를 확인해 주세요` });
            ok = false;
          }
          val = n;
          break;
        }
        case "month": {
          const mo = parseMonth(v);
          if (mo === undefined) {
            errors.push({ row: rowNo, field: def.label, message: `월 형식이 아닙니다 (${String(v)}) → 2026-09처럼 적어 주세요` });
            ok = false;
          }
          val = mo;
          break;
        }
        case "date": {
          const d = parseDate(v);
          if (d === undefined) {
            errors.push({ row: rowNo, field: def.label, message: `날짜 형식이 아닙니다 (${String(v)}) → 2026-10-15처럼 적어 주세요` });
            ok = false;
          }
          val = d;
          break;
        }
        case "grade": {
          const g = parseGrade(v);
          if (g === undefined) {
            errors.push({ row: rowNo, field: def.label, message: `등급은 A·B·C·D 중 하나여야 합니다 (${String(v)}) → 영문 대문자 한 글자로 적어 주세요` });
            ok = false;
          }
          val = g;
          break;
        }
        case "list":
          val = parseList(v);
          break;
        case "boolean": {
          const b = parseBool(v);
          if (b === undefined) {
            warnings.push({ row: rowNo, field: def.label, message: `참/거짓 값을 해석하지 못해 '아니오'로 처리했습니다 (${String(v)})` });
          }
          val = b ?? false;
          break;
        }
        case "history": {
          const h = parseHistory(v);
          if (h === undefined) {
            warnings.push({ row: rowNo, field: def.label, message: "평가 이력 형식을 해석하지 못해 비워 두었습니다 (예: 2025H1:B:84:사유;2025H2:B:83)" });
          }
          val = h ?? [];
          break;
        }
        default:
          val = isBlank(v) ? null : String(v).trim();
      }
      out[def.key] = val;
      if (errors.length > errCount && errors[errors.length - 1].field === def.label && errors[errors.length - 1].row === rowNo) badFields.add(def.key);
    }
    for (const def of schema.fields) {
      if (out[def.key] === undefined || out[def.key] === null) {
        if (def.defaultValue !== undefined) out[def.key] = def.defaultValue;
        else if (def.type === "list" || def.type === "history") out[def.key] = [];
      }
      if (def.required && isBlank(out[def.key]) && !badFields.has(def.key)) {
        errors.push({ row: rowNo, field: def.label, message: "필수값이 비어 있습니다 → 값을 채워 다시 올리면 이 행도 반영됩니다" });
        ok = false;
      }
    }
    const pk = pkOf(schema, out);
    if (ok && seen.has(pk)) {
      errors.push({ row: rowNo, field: Array.isArray(schema.primaryKey) ? schema.primaryKey.join("+") : schema.primaryKey, message: `중복된 행입니다 (${pk} · 파일에 두 번 있음) → 한 줄만 남겨 주세요. 뒤의 행은 반영하지 않습니다` });
      ok = false;
    }
    if (ok && dataset === "materialPrices" && out.market && !["국제", "국내"].includes(String(out.market))) {
      warnings.push({ row: rowNo, field: "시장", message: `시장은 '국제' 또는 '국내'로 적어 주세요 (${String(out.market)})` });
    }
    if (ok && dataset === "purchaseOrders" && out.dueDate && out.orderDate && String(out.dueDate) < String(out.orderDate)) {
      warnings.push({ row: rowNo, field: "납기 예정일", message: "납기 예정일이 발주 일자보다 빠릅니다" });
    }
    if (ok && itemSet && "itemCode" in out && dataset !== "items" && out.itemCode && !itemSet.has(String(out.itemCode))) {
      warnings.push({ row: rowNo, field: "품목코드", message: `품목 마스터에 없는 품목코드입니다 (${String(out.itemCode)})` });
    }
    if (ok && supSet && dataset !== "suppliers" && dataset !== "competitorSupply") {
      const sid = out.supplierId ?? out.mainSupplierId;
      if (sid && !supSet.has(String(sid))) {
        warnings.push({ row: rowNo, field: "업체ID", message: `협력업체 목록에 없는 업체ID입니다 (${String(sid)})` });
      }
    }
    if (ok) {
      seen.add(pk);
      rows.push(out);
    }
  });

  return { dataset, rows, total: rawRows.length, errors, warnings, mapped, unmapped, missingRequired };
}

/** JSON 파일: 배열 또는 {rows:[...]} / {data:[...]} / {<dataset>: [...]} 형태를 허용 */
export function rowsFromJSON(text: string, dataset: DatasetKey): Record<string, unknown>[] {
  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    for (const k of [dataset, "rows", "data", "records"]) {
      if (Array.isArray(o[k])) return o[k] as Record<string, unknown>[];
    }
  }
  throw new Error("JSON은 행 배열이거나 rows/data 배열을 포함해야 합니다");
}

/** 업로드 전 데이터 종류를 헤더로 추정 (사용자가 고른 탭이 기본값) */
export function guessDataset(headers: string[]): DatasetKey | null {
  let best: { key: DatasetKey; score: number } | null = null;
  for (const key of Object.keys(SCHEMAS) as DatasetKey[]) {
    const { mapped, missingRequired } = mapHeaders(key, headers);
    const score = mapped.length - missingRequired.length * 3;
    if (!best || score > best.score) best = { key, score };
  }
  return best && best.score > 0 ? best.key : null;
}
