// 공통 UI 조각
import type { ReactNode } from "react";
import type { ColumnKind, ResultColumn } from "../lib/analysisTypes";
import { fmtDate, fmtInt, fmtMoney, fmtNum, fmtPct, fmtSignedPct } from "../lib/format";

export function GradeBadge({ grade, size = "sm" }: { grade: string | null | undefined; size?: "sm" | "md" }) {
  if (!grade) return <span className="grade grade-none">–</span>;
  return <span className={`grade grade-${grade} grade-${size}`} aria-label={`${grade}등급`}>{grade}</span>;
}

const STATUS_TONE: Record<string, "ok" | "warn" | "bad" | "info" | "muted"> = {
  입고완료: "ok",
  지연입고: "warn",
  "납기 지연": "bad",
  "진행 중": "info",
  취소: "muted",
  정상: "ok",
  "안전재고 미달": "warn",
  "공급 지연": "warn",
  "미달·지연": "bad",
  확인: "ok",
  누락: "bad",
  "표본 적음": "warn",
  임박: "bad",
  예정: "info",
  이후: "muted",
  "지급 확인 필요": "warn",
  "조건 확인 필요": "warn",
  "입고 대기": "muted",
};

export function StatusPill({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="muted">–</span>;
  const tone = STATUS_TONE[value] ?? "muted";
  return <span className={`pill pill-${tone}`}>{value}</span>;
}

export function Chip({ children, onRemove, tone = "neutral" }: { children: ReactNode; onRemove?: () => void; tone?: "neutral" | "accent" }) {
  return (
    <span className={`chip chip-${tone}`}>
      {children}
      {onRemove && (
        <button type="button" className="chip-x" onClick={onRemove} aria-label="선택 해제">
          ×
        </button>
      )}
    </span>
  );
}

export function formatCell(kind: ColumnKind, v: unknown, currency = "KRW", digits?: number): ReactNode {
  if (v === null || v === undefined || v === "") return <span className="muted">–</span>;
  switch (kind) {
    case "int":
      return fmtInt(Number(v));
    case "number":
      return fmtNum(Number(v), digits ?? 1);
    case "percent":
      return fmtPct(Number(v), digits ?? 1);
    case "signedPercent":
      return fmtSignedPct(Number(v), digits ?? 1);
    case "money":
      return fmtMoney(Number(v), currency);
    case "grade":
      return <GradeBadge grade={String(v)} />;
    case "date":
      return fmtDate(String(v));
    case "status":
      return <StatusPill value={String(v)} />;
    default:
      return String(v);
  }
}

export const isNumericKind = (c: Pick<ResultColumn, "kind">) => ["int", "number", "percent", "signedPercent", "money"].includes(c.kind);

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}
