// CSV 읽기·쓰기 (RFC 4180: 따옴표, 쉼표, 줄바꿈 포함 필드 지원)

export function parseCSV(text: string): Record<string, string>[] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => {
      if (h) obj[h] = (cells[idx] ?? "").trim();
    });
    return obj;
  });
}

function escapeCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = Array.isArray(v) ? v.join(";") : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 엑셀에서 한글이 깨지지 않도록 BOM을 붙인다 */
export function toCSV(headers: { key: string; label: string }[], rows: Record<string, unknown>[]): string {
  const lines = [headers.map((h) => escapeCell(h.label)).join(",")];
  for (const r of rows) lines.push(headers.map((h) => escapeCell(r[h.key])).join(","));
  return "﻿" + lines.join("\r\n");
}
