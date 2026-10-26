// 보기 설정: 템플릿별 상세 레이아웃 + 프리셋(기본 4종, 사용자 저장)
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LuBookmarkPlus, LuRotateCcw, LuTrash2, LuX } from "react-icons/lu";
import type { AnalysisResult, TemplateId } from "../lib/analysisTypes";
import { useStore, uid } from "../store/store";
import {
  BUILT_IN_PRESETS,
  DEFAULT_SETTINGS,
  REPORT_SECTIONS,
  clone,
  matchPreset,
  normalizeSettings,
  resolveCharts,
  resolveColumns,
  resolveMetrics,
  type ViewSettings,
} from "../templates/presets";
import { TEMPLATES } from "../templates/registry";

const MAX_USER_PRESETS = 12;

function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg-ctl" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.v)} type="button" role="radio" aria-checked={value === o.v} className={value === o.v ? "is-on" : ""} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="vs-row">
      <div className="vs-row-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="vs-row-ctl">{children}</div>
    </div>
  );
}

function Check({ checked, onChange, children, disabled }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean }) {
  return (
    <label className={`check ${disabled ? "is-disabled" : ""}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <span>{children}</span>
    </label>
  );
}

export function ViewSettingsPanel({ result, template, onClose }: { result: AnalysisResult | null; template: TemplateId; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const s = state.settings;
  const [name, setName] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const set = (next: ViewSettings) => dispatch({ type: "settings", settings: next });
  const patch = <K extends keyof ViewSettings>(k: K, v: Partial<ViewSettings[K]>) => set({ ...s, [k]: { ...s[k], ...v } });
  const allPresets = [...BUILT_IN_PRESETS, ...state.userPresets];
  const active = matchPreset(s, allPresets);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(t) && !t.closest(".vs-toggle")) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const save = () => {
    const n = name.trim();
    if (!n) return;
    const existing = state.userPresets.find((p) => p.name === n);
    if (!existing && state.userPresets.length >= MAX_USER_PRESETS) {
      dispatch({ type: "toast", text: `내 프리셋은 ${MAX_USER_PRESETS}개까지 저장할 수 있습니다. 쓰지 않는 프리셋을 지워 주세요.`, tone: "warn" });
      return;
    }
    dispatch({ type: "savePreset", preset: { id: existing?.id ?? `user-${uid()}`, name: n, description: "내가 저장한 설정", settings: clone(s) } });
    dispatch({ type: "toast", text: existing ? `'${n}' 프리셋을 현재 설정으로 덮어썼습니다` : `'${n}' 프리셋을 저장했습니다` });
    setName("");
  };

  const cols = result ? resolveColumns(result, s.table.columns).map((c) => c.key) : [];
  const charts = result ? resolveCharts(result, s.chart.charts).map((c) => c.id) : [];
  const metrics = result ? resolveMetrics(result, s.cards.metrics) : [];
  const sortOptions = result
    ? [
        ...(result.rows.some((r) => r.rank) ? [{ v: "__rank", label: result.rankLabel ?? "분석 순서" }] : []),
        { v: "__label", label: "대상 이름" },
        ...result.columns.filter((c) => c.kind !== "text").map((c) => ({ v: c.key, label: c.label })),
      ]
    : [{ v: "__rank", label: "분석 순서" }];

  return (
    <div className="vs-panel" ref={ref} role="dialog" aria-label="보기 설정">
      <div className="vs-head">
        <h3>보기 설정</h3>
        <p>보이는 방식만 바꾸고 분석 결과 수치는 바꾸지 않습니다. 설정은 이 브라우저에 저장됩니다.</p>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="보기 설정 닫기">
          <LuX aria-hidden />
        </button>
      </div>

      <section className="vs-sec">
        <h4>프리셋</h4>
        <div className="preset-list">
          {BUILT_IN_PRESETS.map((p) => (
            <button key={p.id} type="button" className={`preset ${active === p.id ? "is-on" : ""}`} onClick={() => set(normalizeSettings(p.settings))} aria-pressed={active === p.id} data-preset={p.id}>
              <b>{p.name}</b>
              <small>{p.description}</small>
            </button>
          ))}
        </div>
        {state.userPresets.length > 0 && (
          <div className="user-presets" aria-label="내 프리셋">
            {state.userPresets.map((p) => (
              <span key={p.id} className={`user-preset ${active === p.id ? "is-on" : ""}`}>
                <button type="button" onClick={() => set(normalizeSettings(p.settings))} aria-pressed={active === p.id}>
                  {p.name}
                </button>
                <button type="button" className="user-preset-del" onClick={() => dispatch({ type: "deletePreset", id: p.id })} aria-label={`${p.name} 프리셋 삭제`} title="삭제">
                  <LuTrash2 aria-hidden />
                </button>
              </span>
            ))}
          </div>
        )}
        <form
          className="preset-save"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label htmlFor="preset-name" className="sr-only">
            프리셋 이름
          </label>
          <input id="preset-name" type="text" placeholder="현재 설정을 내 프리셋으로 저장 · 이름 입력" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="btn" disabled={!name.trim()}>
            <LuBookmarkPlus aria-hidden /> 저장
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => set(clone(DEFAULT_SETTINGS))} disabled={active === "default"}>
            <LuRotateCcw aria-hidden /> 기본값으로
          </button>
        </form>
      </section>

      <section className="vs-sec">
        <h4>{TEMPLATES[template].label} 레이아웃</h4>
        {template === "table" && (
          <>
            <Row label="표시할 열" hint={result ? undefined : "결과가 있으면 열을 고를 수 있습니다"}>
              <div className="vs-inline">
                <button type="button" className={`chip-btn ${s.table.columns === "primary" ? "is-on" : ""}`} onClick={() => patch("table", { columns: "primary" })}>
                  주요 열
                </button>
                <button type="button" className={`chip-btn ${s.table.columns === "all" ? "is-on" : ""}`} onClick={() => patch("table", { columns: "all" })}>
                  모든 열
                </button>
              </div>
              {result && (
                <div className="check-grid">
                  {result.columns.map((c) => (
                    <Check
                      key={c.key}
                      checked={cols.includes(c.key)}
                      disabled={cols.length === 1 && cols.includes(c.key)}
                      onChange={(on) => {
                        const next = result.columns.map((x) => x.key).filter((k) => (k === c.key ? on : cols.includes(k)));
                        patch("table", { columns: next.length ? next : "primary" });
                      }}
                    >
                      {c.label}
                    </Check>
                  ))}
                </div>
              )}
            </Row>
            <Row label="행 간격">
              <Seg label="행 간격" value={s.table.density} onChange={(v) => patch("table", { density: v })} options={[{ v: "compact", label: "촘촘" }, { v: "comfortable", label: "보통" }]} />
            </Row>
            <Row label="기본 정렬">
              <div className="vs-inline">
                <select id="vs-table-sort" value={s.table.sort?.key ?? "__rank"} onChange={(e) => patch("table", { sort: { key: e.target.value, dir: s.table.sort?.dir ?? "asc" } })}>
                  {sortOptions.map((o) => (
                    <option key={o.v} value={o.v}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <Seg label="정렬 방향" value={s.table.sort?.dir ?? "asc"} onChange={(v) => patch("table", { sort: { key: s.table.sort?.key ?? "__rank", dir: v } })} options={[{ v: "asc", label: "오름차순" }, { v: "desc", label: "내림차순" }]} />
              </div>
            </Row>
            <Row label="표시 옵션">
              <div className="vs-inline">
                <Check checked={s.table.showBest} onChange={(v) => patch("table", { showBest: v })}>
                  최고값 표시
                </Check>
                <Check checked={s.table.showExcluded} onChange={(v) => patch("table", { showExcluded: v })}>
                  순위 제외 대상도 표시
                </Check>
              </div>
            </Row>
          </>
        )}
        {template === "chart" && (
          <>
            <Row label="표시할 차트" hint={result ? undefined : "결과가 있으면 차트를 고를 수 있습니다"}>
              {result && (
                <div className="check-grid one">
                  {result.charts.map((c) => (
                    <Check
                      key={c.id}
                      checked={charts.includes(c.id)}
                      disabled={charts.length === 1 && charts.includes(c.id)}
                      onChange={(on) => {
                        const next = result.charts.map((x) => x.id).filter((k) => (k === c.id ? on : charts.includes(k)));
                        patch("chart", { charts: next.length ? next : "all" });
                      }}
                    >
                      {c.title}
                    </Check>
                  ))}
                </div>
              )}
            </Row>
            <Row label="한 줄에 차트">
              <Seg label="한 줄에 차트" value={s.chart.perRow} onChange={(v) => patch("chart", { perRow: v })} options={[{ v: 1, label: "1개" }, { v: 2, label: "2개" }]} />
            </Row>
            <Row label="표시 옵션">
              <div className="vs-inline">
                <Check checked={s.chart.valueLabels} onChange={(v) => patch("chart", { valueLabels: v })}>
                  값 라벨
                </Check>
                <Check checked={s.chart.refLine} onChange={(v) => patch("chart", { refLine: v })}>
                  기준선
                </Check>
              </div>
            </Row>
          </>
        )}
        {template === "cards" && (
          <>
            <Row label="한 줄에 카드">
              <Seg label="한 줄에 카드" value={s.cards.perRow} onChange={(v) => patch("cards", { perRow: v })} options={[{ v: 1, label: "1개" }, { v: 2, label: "2개" }, { v: 3, label: "3개" }]} />
            </Row>
            <Row label="카드에 보일 지표" hint="최대 6개">
              {result ? (
                <div className="check-grid">
                  {result.columns
                    .filter((c) => c.kind !== "text")
                    .map((c) => (
                      <Check
                        key={c.key}
                        checked={metrics.includes(c.key)}
                        disabled={(!metrics.includes(c.key) && metrics.length >= 6) || (metrics.length === 1 && metrics.includes(c.key))}
                        onChange={(on) => {
                          const next = result.columns.map((x) => x.key).filter((k) => (k === c.key ? on : metrics.includes(k)));
                          patch("cards", { metrics: next.length ? next : "default" });
                        }}
                      >
                        {c.label}
                      </Check>
                    ))}
                </div>
              ) : (
                <span className="muted">결과가 있으면 지표를 고를 수 있습니다</span>
              )}
            </Row>
            <Row label="정렬 기준" hint="자동 = 좋은 값이 먼저">
              <div className="vs-inline">
                <select id="vs-cards-sort" value={s.cards.sort} onChange={(e) => patch("cards", { sort: e.target.value })}>
                  {sortOptions.map((o) => (
                    <option key={o.v} value={o.v}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <Seg
                  label="카드 정렬 방향"
                  value={s.cards.sortDir ?? "auto"}
                  onChange={(v) => patch("cards", { sortDir: v })}
                  options={[
                    { v: "auto", label: "자동" },
                    { v: "asc", label: "오름차순" },
                    { v: "desc", label: "내림차순" },
                  ]}
                />
              </div>
            </Row>
            <Row label="강점·위험 요소">
              <Seg label="강점·위험 요소" value={s.cards.expand ? "on" : "off"} onChange={(v) => patch("cards", { expand: v === "on" })} options={[{ v: "off", label: "핵심 2개만" }, { v: "on", label: "모두 펼침" }]} />
            </Row>
          </>
        )}
        {template === "report" && (
          <>
            <Row label="보고서 형식">
              <Seg label="보고서 형식" value={s.report.mode} onChange={(v) => patch("report", { mode: v })} options={[{ v: "summary", label: "요약형" }, { v: "detailed", label: "상세형" }]} />
            </Row>
            <Row label="포함할 섹션">
              <div className="check-grid">
                {REPORT_SECTIONS.map((sec) => (
                  <Check key={sec.id} checked={s.report.sections[sec.id]} onChange={(v) => patch("report", { sections: { ...s.report.sections, [sec.id]: v } })}>
                    {sec.label}
                  </Check>
                ))}
              </div>
            </Row>
          </>
        )}
      </section>
    </div>
  );
}
