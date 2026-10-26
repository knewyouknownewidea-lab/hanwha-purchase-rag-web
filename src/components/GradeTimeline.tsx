// 협력사 등급 변동 이력 타임라인: 평가 시점별 등급·점수, 이전 대비 상승·하락, 변동 사유, 마지막은 현재 시스템 계산값
import { LuArrowDownRight, LuArrowRight, LuArrowUpRight } from "react-icons/lu";
import { halfLabel, type EvalHistoryEntry } from "../data/types";
import { fmtNum } from "../lib/format";
import { GradeBadge } from "./ui";

const ORDER: Record<string, number> = { A: 4, B: 3, C: 2, D: 1 };

type Point = { key: string; label: string; grade: string | null; score: number | null; reason?: string | null; current?: boolean };

function Delta({ prev, cur }: { prev: Point | undefined; cur: Point }) {
  if (!prev || !prev.grade || !cur.grade) return <span className="tl-delta tl-none">–</span>;
  const d = ORDER[cur.grade] - ORDER[prev.grade];
  if (d > 0)
    return (
      <span className="tl-delta tl-up">
        <LuArrowUpRight aria-hidden /> 상승
      </span>
    );
  if (d < 0)
    return (
      <span className="tl-delta tl-down">
        <LuArrowDownRight aria-hidden /> 하락
      </span>
    );
  return (
    <span className="tl-delta tl-same">
      <LuArrowRight aria-hidden /> 유지
    </span>
  );
}

export function GradeTimeline({ history, current }: { history: EvalHistoryEntry[]; current: { grade: string | null; score: number | null } }) {
  const sorted = [...history].sort((a, b) => a.year - b.year || (a.half ?? 0) - (b.half ?? 0));
  const points: Point[] = [
    ...sorted.map((h) => ({ key: `${h.year}-${h.half ?? 0}`, label: halfLabel(h), grade: h.grade, score: h.score, reason: h.reason })),
    { key: "now", label: "현재 · 시스템 계산", grade: current.grade, score: current.score, current: true },
  ];
  const changes = points.filter((p, i) => i > 0 && p.grade && points[i - 1].grade && p.grade !== points[i - 1].grade).length;
  return (
    <div className="timeline" aria-label="등급 변동 이력">
      <p className="tl-head">
        <b>등급 변동 이력</b>
        <span className="muted">
          공식 평가 {sorted.length}회 · 등급 변동 {changes}회 · 마지막 점은 현재 데이터로 계산한 값(공식 평가 아님)
        </span>
      </p>
      {sorted.length === 0 && <p className="muted small">기록된 평가 이력이 없습니다. 협력업체 파일의 ‘평가 이력’ 열로 올릴 수 있습니다.</p>}
      <ol className="tl-list">
        {points.map((p, i) => (
          <li key={p.key} className={`tl-item ${p.current ? "is-current" : ""}`}>
            <span className="tl-dot" aria-hidden />
            <span className="tl-when">{p.label}</span>
            <span className="tl-grade">
              <GradeBadge grade={p.grade} /> <span className="tl-score">{p.score === null ? "–" : `${fmtNum(p.score, Number.isInteger(p.score) ? 0 : 1)}점`}</span>
            </span>
            <Delta prev={points[i - 1]} cur={p} />
            {!p.current && (p.reason ? <span className="tl-reason">{p.reason}</span> : p.grade && points[i - 1]?.grade && p.grade !== points[i - 1].grade ? <span className="tl-reason is-empty">사유 기록 없음</span> : null)}
          </li>
        ))}
      </ol>
    </div>
  );
}
