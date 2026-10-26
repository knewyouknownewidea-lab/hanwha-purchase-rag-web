// 부품 분류(BOM 경로): 엔진 모델 > 대부품 > 중부품 > 소부품 → 품목코드
import type { BomRow, Item } from "../data/types";
import type { Option } from "./filters";

export const BOM_LEVELS = ["엔진 모델", "대부품", "중부품", "소부품"] as const;

export interface BomIndex {
  rows: BomRow[];
  pathsByItem: Map<string, BomRow[]>;
  hasData: boolean;
}

const keyAt = (r: BomRow, level: number) => [r.engineModel, r.major, r.mid, r.minor][level];

export function buildBomIndex(rows: BomRow[]): BomIndex {
  const pathsByItem = new Map<string, BomRow[]>();
  for (const r of rows) {
    if (!pathsByItem.has(r.itemCode)) pathsByItem.set(r.itemCode, []);
    pathsByItem.get(r.itemCode)!.push(r);
  }
  return { rows, pathsByItem, hasData: rows.length > 0 };
}

const matchesPrefix = (r: BomRow, path: string[]) => path.every((p, i) => !p || keyAt(r, i) === p);

/** 고른 경로 아래에 있는 품목코드 */
export function itemsUnder(index: BomIndex, path: string[]): Set<string> {
  return new Set(index.rows.filter((r) => matchesPrefix(r, path)).map((r) => r.itemCode));
}

/** level 단계에서 고를 수 있는 값 (앞 단계 선택으로 좁힘) */
export function optionsAt(index: BomIndex, path: string[], level: number, items?: Map<string, Item>): Option[] {
  const seen = new Map<string, string>();
  for (const r of index.rows) {
    if (!matchesPrefix(r, path.slice(0, level))) continue;
    const v = keyAt(r, level);
    if (!seen.has(v)) seen.set(v, level === 3 && items?.get(r.itemCode) ? `${v} (${r.itemCode})` : v);
  }
  return [...seen].map(([value, label]) => ({ value, label }));
}

/** 품목 하나의 분류 경로 문구 (엔진이 여러 개면 묶어서) */
export function pathText(index: BomIndex, itemCode: string): string | null {
  const rows = index.pathsByItem.get(itemCode);
  if (!rows?.length) return null;
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const k = `${r.major} › ${r.mid}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r.engineModel.replace(/^SAMPLE\s*/, ""));
  }
  return [...groups].map(([k, engines]) => `${engines.join("·")} › ${k}`).join(" / ");
}
