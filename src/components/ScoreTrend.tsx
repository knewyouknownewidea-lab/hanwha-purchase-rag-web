// 평가점수 추이: 기록된 반기별 종합평가점수(evalHistory)만 선으로 그린다. 기록이 2회 미만이면 점수를 만들지 않고 필요한 자료를 안내한다.
import { halfLabel, type EvalHistoryEntry } from "../data/types";

export const sortHistory = (h: EvalHistoryEntry[]) => [...h].sort((a, b) => a.year - b.year || (a.half ?? 0) - (b.half ?? 0));

export function ScoreTrend({ history, size = "sm" }: { history: EvalHistoryEntry[]; size?: "sm" | "lg" }) {
  const pts = sortHistory(history).filter((h) => Number.isFinite(h.score));
  if (pts.length < 2)
    return (
      <span className="trend-missing" data-trend="missing">
        {pts.length ? `${halfLabel(pts[0], true)} ${pts[0].score}점 1회 · ` : ""}추이에는 반기별 평가점수 2회 이상 필요
      </span>
    );
  const [w, h, pad] = size === "lg" ? [480, 150, 26] : [96, 30, 4];
  const scores = pts.map((p) => p.score);
  const lo = Math.min(...scores) - 1;
  const hi = Math.max(...scores) + 1;
  const x = (i: number) => pad + (i * (w - pad * 2)) / (pts.length - 1);
  const y = (v: number) => h - pad - ((v - lo) / (hi - lo)) * (h - pad * 2);
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(" ");
  const label = pts.map((p) => `${halfLabel(p)} ${p.score}점`).join(", ");
  const last = pts[pts.length - 1];
  return (
    <span className={`trend trend-${size}`} data-trend="line" data-points={pts.length}>
      {/* 크기를 줄이지 않고 그대로 그려 글자가 12px 아래로 작아지지 않게 한다 (좁은 화면은 그래프 칸 안에서 옆으로 밀기) */}
      <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={`평가점수 추이: ${label}`}>
        <title>{label}</title>
        <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth={size === "lg" ? 2.5 : 1.75} vectorEffect="non-scaling-stroke" />
        {pts.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.score)} r={size === "lg" ? 4 : i === pts.length - 1 ? 2.5 : 0} fill="var(--accent)" />
        ))}
        {size === "lg" &&
          pts.map((p, i) => (
            <g key={`t${i}`} fontSize="12" textAnchor="middle">
              <text x={x(i)} y={y(p.score) - 9} fill="var(--ink-2)">
                {p.score}
              </text>
              <text x={x(i)} y={h - 2} fill="var(--muted)">
                {halfLabel(p, true)}
              </text>
            </g>
          ))}
      </svg>
      {size === "sm" && <span className="trend-last">{last.score}점</span>}
    </span>
  );
}
