// 차트 렌더러 — 막대(세로·가로)와 선 그래프. Recharts 대신 SVG/HTML로 직접 그린다.
// 원칙: 막대는 0에서 시작, 축은 하나, 2개 이상 계열이면 범례, 마우스를 올리면 값 표시, 데이터 표 제공
import { useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { ChartSpec } from "../../lib/analysisTypes";
import { fmtInt, fmtNum } from "../../lib/format";
import { ScrollX } from "../ScrollX";

const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)"];
const colorOf = (spec: ChartSpec, i: number) => (spec.series.length === 1 ? "var(--series-single)" : SERIES[i % SERIES.length]);

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setW(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export function fmtValue(v: number | null | undefined, unit: string, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  if (unit === "원") return `${fmtInt(v)}원`;
  if (unit === "%") return `${fmtNum(v, digits)}%`;
  if (unit === "점") return `${fmtNum(v, digits)}점`;
  if (!unit) return fmtNum(v, digits);
  return `${fmtNum(v, digits)} ${unit}`;
}

function axisFmt(v: number, unit: string) {
  if (unit === "원" && Math.abs(v) >= 10000) {
    const man = v / 10000;
    return `${fmtNum(man, Number.isInteger(man) || Math.abs(man) >= 100 ? 0 : 1)}만`;
  }
  if (Math.abs(v) >= 1000) return fmtInt(v);
  return fmtNum(v, Number.isInteger(v) ? 0 : 1);
}

function niceStep(range: number, ticks: number) {
  const raw = range / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const norm = raw / mag;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return step * mag;
}

function niceScale(lo: number, hi: number, ticks = 4, zero = false, unit = "") {
  let min = zero ? 0 : lo;
  let max = hi;
  if (unit === "%" && hi <= 100 && zero) max = 100;
  if (max === min) {
    max = max + (max === 0 ? 1 : Math.abs(max) * 0.1);
    if (!zero) min = min - Math.abs(min) * 0.1;
  }
  const step = niceStep(max - min, ticks);
  min = Math.floor(min / step) * step;
  max = Math.ceil(max / step) * step;
  if (unit === "%" && max > 100 && hi <= 100) max = 100;
  const out: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return { min, max, ticks: out };
}

// 글자 폭: 한글 1, 영문·숫자·기호 0.6 으로 어림해 자른다
const unitsOf = (ch: string) => (/[\u1100-\uffdc]/.test(ch) ? 1 : 0.6);
const truncate = (s: string, max: number) => {
  const chars = [...s];
  const total = chars.reduce((a, c) => a + unitsOf(c), 0);
  if (total <= max) return s;
  let u = 0;
  let out = "";
  for (const c of chars) {
    if (u + unitsOf(c) > max - 1) break;
    u += unitsOf(c);
    out += c;
  }
  return (out || chars[0]) + "…";
};

function Legend({ spec }: { spec: ChartSpec }) {
  const items: ReactNode[] = [];
  if (spec.series.length > 1)
    spec.series.forEach((s, i) =>
      items.push(
        <span key={s.key} className="legend-item">
          <i className="legend-swatch" style={{ background: colorOf(spec, i) }} />
          {s.label}
        </span>,
      ),
    );
  if (spec.statusOf?.some(Boolean))
    items.push(
      <span key="status" className="legend-item">
        <i className="legend-swatch legend-status" />
        <b className="status-icon" aria-hidden>
          !
        </b>
        {spec.statusLabel ?? "기준 미달"}
      </span>,
    );
  if (spec.refLine)
    items.push(
      <span key="ref" className="legend-item">
        <i className="legend-ref" />
        {spec.refLine.label}
      </span>,
    );
  if (!items.length) return null;
  return <div className="legend">{items}</div>;
}

function DataTable({ spec }: { spec: ChartSpec }) {
  return (
    <details className="chart-table">
      <summary>데이터 표</summary>
      <ScrollX>
        <table>
          <thead>
            <tr>
              <th>{spec.xLabel ?? "항목"}</th>
              {spec.series.map((s) => (
                <th key={s.key} className="num">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {spec.categories.map((c, ci) => (
              <tr key={c + ci}>
                <td>{c}</td>
                {spec.series.map((s) => (
                  <td key={s.key} className="num">
                    {fmtValue(s.values[ci], spec.unit, spec.digits)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollX>
    </details>
  );
}

function BarChart({ spec, valueLabels }: { spec: ChartSpec; valueLabels: boolean }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = spec.xMarker ? 254 : 240;
  const m = { t: spec.xMarker ? 36 : 22, r: 12, b: 32, l: 52 };
  const pw = Math.max(10, W - m.l - m.r);
  const ph = H - m.t - m.b;
  const vals = spec.series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const hi = Math.max(0, ...vals, spec.refLine?.value ?? 0);
  const sc = niceScale(0, hi, 4, true, spec.unit);
  const y = (v: number) => m.t + ph - ((v - sc.min) / (sc.max - sc.min)) * ph;
  const n = spec.categories.length;
  const band = pw / Math.max(1, n);
  const k = spec.series.length;
  const bw = Math.min(40, (band * 0.62 - (k - 1) * 2) / k);
  const groupW = bw * k + (k - 1) * 2;
  const showValues = valueLabels && n * k <= 12;
  const maxChars = Math.max(2, Math.floor(band / 12.5));
  const barPath = (x: number, top: number, w: number, bottom: number) => {
    const h = bottom - top;
    const r = Math.min(4, w / 2, h);
    if (h <= 0) return "";
    return `M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${bottom}Z`;
  };
  return (
    <div className="chart" ref={ref}>
      <Legend spec={spec} />
      {W > 0 && (
        <div className="chart-canvas">
          <svg width={W} height={H} role="img" aria-label={spec.title}>
            {sc.ticks.map((t) => (
              <g key={t}>
                <line x1={m.l} x2={m.l + pw} y1={y(t)} y2={y(t)} className={t === 0 ? "axis-base" : "grid"} />
                <text x={m.l - 6} y={y(t)} className="tick" textAnchor="end" dominantBaseline="middle">
                  {axisFmt(t, spec.unit)}
                </text>
              </g>
            ))}
            {spec.categories.map((c, ci) => {
              const gx = m.l + band * ci + (band - groupW) / 2;
              return (
                <g key={c + ci} opacity={hover === null || hover === ci ? 1 : 0.45}>
                  {spec.series.map((s, si) => {
                    const v = s.values[ci];
                    if (v === null || v === undefined) return null;
                    const x = gx + si * (bw + 2);
                    const crit = k === 1 && spec.statusOf?.[ci] === "critical";
                    return (
                      <g key={s.key}>
                        <path d={barPath(x, y(v), bw, y(0))} fill={crit ? "var(--status-critical)" : colorOf(spec, si)} />
                        {showValues && (
                          <text x={x + bw / 2} y={y(v) - 5} className="bar-value" textAnchor="middle">
                            {crit ? "! " : ""}
                            {spec.unit === "원" ? axisFmt(v, "원") : fmtNum(v, spec.digits ?? 1)}
                          </text>
                        )}
                      </g>
                    );
                  })}
                  <text x={m.l + band * ci + band / 2} y={H - m.b + 18} className="cat" textAnchor="middle">
                    <title>{c}</title>
                    {truncate(c, maxChars)}
                  </text>
                  <rect
                    x={m.l + band * ci}
                    y={m.t}
                    width={band}
                    height={ph}
                    fill="transparent"
                    onMouseEnter={() => setHover(ci)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(ci)}
                    onBlur={() => setHover(null)}
                    tabIndex={0}
                    aria-label={`${c}: ${spec.series.map((s) => `${s.label} ${fmtValue(s.values[ci], spec.unit, spec.digits)}`).join(", ")}`}
                  />
                </g>
              );
            })}
            {spec.refLine && (
              <g pointerEvents="none">
                <line x1={m.l} x2={m.l + pw} y1={y(spec.refLine.value)} y2={y(spec.refLine.value)} className="ref-line" />
              </g>
            )}
            {spec.xMarker && (
              <g pointerEvents="none">
                <line x1={m.l + band * spec.xMarker.index} x2={m.l + band * spec.xMarker.index} y1={m.t - 20} y2={m.t + ph} className="x-marker-line" />
                <text x={m.l + band * spec.xMarker.index + 5} y={m.t - 10} className="x-marker-label">
                  {spec.xMarker.label}
                </text>
              </g>
            )}
          </svg>
          {hover !== null && (
            <div className="tooltip" style={{ left: Math.min(Math.max(m.l + band * hover + band / 2, 70), W - 70), top: 4 }}>
              <strong>{spec.categories[hover]}</strong>
              {spec.series.map((s, si) => (
                <span key={s.key}>
                  {k > 1 && <i className="legend-swatch" style={{ background: colorOf(spec, si) }} />}
                  {s.label} {fmtValue(s.values[hover], spec.unit, spec.digits)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="axis-label">{spec.yLabel}</div>
    </div>
  );
}

function HBarChart({ spec, valueLabels }: { spec: ChartSpec; valueLabels: boolean }) {
  const s = spec.series[0];
  const vals = s.values.filter((v): v is number => v !== null);
  const hi = Math.max(0, ...vals, spec.refLine?.value ?? 0);
  const sc = niceScale(0, hi, 4, true, spec.unit);
  const pct = (v: number) => ((v - sc.min) / (sc.max - sc.min)) * 100;
  return (
    <div className="chart">
      <Legend spec={spec} />
      <div className="hbar" role="list" aria-label={spec.title}>
        {spec.categories.map((c, i) => {
          const v = s.values[i];
          const crit = spec.statusOf?.[i] === "critical";
          return (
            <div className="hbar-row" role="listitem" key={c + i} title={`${c}: ${fmtValue(v, spec.unit, spec.digits)}`} tabIndex={0}>
              <span className="hbar-label">{c}</span>
              <div className="hbar-track">
                {v !== null && <div className="hbar-fill" style={{ width: `${Math.max(0.5, pct(v))}%`, background: crit ? "var(--status-critical)" : "var(--series-single)" }} />}
                {spec.refLine && <i className="hbar-ref" style={{ left: `${pct(spec.refLine.value)}%` }} />}
              </div>
              <span className={`hbar-val ${crit ? "is-crit" : ""} ${valueLabels ? "" : "sr-only"}`}>
                {crit && (
                  <b className="status-icon" aria-hidden>
                    !
                  </b>
                )}
                {fmtValue(v, spec.unit, spec.digits)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="hbar-axis">
        <span>{axisFmt(sc.min, spec.unit)}</span>
        <span>{spec.yLabel}</span>
        <span>{axisFmt(sc.max, spec.unit)}</span>
      </div>
    </div>
  );
}

function LineChart({ spec }: { spec: ChartSpec }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 250;
  const endLabels = spec.series.length >= 2 && spec.series.length <= 4;
  const m = { t: 16, r: endLabels ? 84 : 16, b: 32, l: 56 };
  const pw = Math.max(10, W - m.l - m.r);
  const ph = H - m.t - m.b;
  const vals = spec.series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  if (!vals.length) return <p className="muted small">표시할 값이 없습니다.</p>;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1;
  const sc = niceScale(lo - pad, hi + pad, 4, false, spec.unit);
  if (spec.unit === "%") {
    sc.max = Math.min(sc.max, 100);
  }
  const n = spec.categories.length;
  const x = (i: number) => m.l + (n <= 1 ? pw / 2 : (pw * i) / (n - 1));
  const y = (v: number) => m.t + ph - ((v - sc.min) / (sc.max - sc.min || 1)) * ph;
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 66))));
  const paths = spec.series.map((s) => {
    let d = "";
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  });
  // 끝점 라벨: 겹치지 않게 세로 위치를 벌린다
  const ends = spec.series
    .map((s, si) => {
      let li = -1;
      s.values.forEach((v, i) => v !== null && (li = i));
      return li < 0 ? null : { si, i: li, v: s.values[li] as number, yy: y(s.values[li] as number) };
    })
    .filter(Boolean) as { si: number; i: number; v: number; yy: number }[];
  ends.sort((a, b) => a.yy - b.yy);
  for (let i = 1; i < ends.length; i++) if (ends[i].yy - ends[i - 1].yy < 15) ends[i].yy = ends[i - 1].yy + 15;
  const onMove = (e: MouseEvent<SVGRectElement>) => {
    const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = n <= 1 ? 0 : Math.round((px / rect.width) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  return (
    <div className="chart" ref={ref}>
      <Legend spec={spec} />
      {W > 0 && (
        <div className="chart-canvas">
          <svg width={W} height={H} role="img" aria-label={spec.title}>
            {sc.ticks.map((t) => (
              <g key={t}>
                <line x1={m.l} x2={m.l + pw} y1={y(t)} y2={y(t)} className="grid" />
                <text x={m.l - 6} y={y(t)} className="tick" textAnchor="end" dominantBaseline="middle">
                  {axisFmt(t, spec.unit)}
                </text>
              </g>
            ))}
            <line x1={m.l} x2={m.l + pw} y1={m.t + ph} y2={m.t + ph} className="axis-base" />
            {spec.categories.map((c, i) =>
              i % every === 0 || i === n - 1 ? (
                <text key={c + i} x={x(i)} y={H - m.b + 18} className="cat" textAnchor="middle">
                  {c}
                </text>
              ) : null,
            )}
            {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={m.t + ph} className="crosshair" />}
            {paths.map((d, si) => (
              <path key={si} d={d} fill="none" stroke={colorOf(spec, si)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {ends.map((e) => (
              <circle key={`end-${e.si}`} cx={x(e.i)} cy={y(e.v)} r={4} fill={colorOf(spec, e.si)} stroke="var(--surface)" strokeWidth={2} />
            ))}
            {hover !== null &&
              spec.series.map((s, si) =>
                s.values[hover] !== null ? <circle key={`h-${si}`} cx={x(hover)} cy={y(s.values[hover] as number)} r={4.5} fill={colorOf(spec, si)} stroke="var(--surface)" strokeWidth={2} /> : null,
              )}
            {endLabels &&
              ends.map((e) => (
                <text key={`lbl-${e.si}`} x={x(e.i) + 8} y={e.yy} className="end-label" dominantBaseline="middle">
                  {truncate(spec.series[e.si].label, 7)}
                </text>
              ))}
            <rect x={m.l} y={m.t} width={pw} height={ph} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
          </svg>
          {hover !== null && (
            <div className="tooltip" style={{ left: Math.min(Math.max(x(hover), 80), W - 80), top: 4 }}>
              <strong>{spec.categories[hover]}</strong>
              {spec.series.map((s, si) => (
                <span key={s.key}>
                  {spec.series.length > 1 && <i className="legend-swatch" style={{ background: colorOf(spec, si) }} />}
                  {s.label} {fmtValue(s.values[hover], spec.unit, spec.digits)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="axis-label">{spec.yLabel}</div>
    </div>
  );
}

export function Chart({ spec: raw, valueLabels = true, refLine = true }: { spec: ChartSpec; valueLabels?: boolean; refLine?: boolean }) {
  const spec = refLine ? raw : { ...raw, refLine: undefined };
  const hasData = spec.series.some((s) => s.values.some((v) => v !== null)) && spec.categories.length > 0;
  return (
    <figure className="chart-card">
      <figcaption className="chart-title">{spec.title}</figcaption>
      {!hasData ? (
        <p className="muted small">표시할 데이터가 없습니다.</p>
      ) : spec.type === "hbar" ? (
        <HBarChart spec={spec} valueLabels={valueLabels} />
      ) : spec.type === "line" ? (
        <LineChart spec={spec} />
      ) : (
        <BarChart spec={spec} valueLabels={valueLabels} />
      )}
      {spec.caption && <p className="chart-caption">{spec.caption}</p>}
      {hasData && <DataTable spec={spec} />}
    </figure>
  );
}
