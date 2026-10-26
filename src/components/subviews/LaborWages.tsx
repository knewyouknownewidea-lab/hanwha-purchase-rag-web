// 원가-계약 › 인건비 동향: 직종 대·중·소 분류 트리 + 월평균 임금 추이·전년 대비 상승률·상위 분류 비교
import { useMemo, useState } from "react";
import { LuChevronDown, LuChevronRight, LuInfo } from "react-icons/lu";
import { useStore } from "../../store/store";
import { Chart } from "../charts/Chart";
import type { ChartSpec } from "../../lib/analysisTypes";
import { fmtInt, fmtSignedPct, round } from "../../lib/format";
import { buildWageTree, findNode, jobsForProcess, type WageNode } from "../../lib/market";
import { SubViewHead } from "./SubViewHead";

const LEVEL = ["대분류", "중분류", "소분류"];

function Delta({ v }: { v: number | null }) {
  if (v === null) return <span className="muted">–</span>;
  return <span className={v > 0 ? "delta-up" : v < 0 ? "delta-down" : ""}>{fmtSignedPct(v)}</span>;
}

export function LaborWages() {
  const { state, derived } = useStore();
  const { roots, months } = useMemo(() => buildWageTree(state.data.laborWages), [state.data.laborWages]);
  const [path, setPath] = useState<string[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set(roots.map((r) => r.name)));
  const [span, setSpan] = useState(24);
  const sel = (path && findNode(roots, path)) || roots[0] || null;
  const parent = sel && sel.path.length > 1 ? findNode(roots, sel.path.slice(0, -1)) : null;
  const allAvg = useMemo(() => {
    if (!roots.length) return [] as (number | null)[];
    return months.map((_, i) => {
      const v = roots.map((r) => r.series[i]).filter((x): x is number => x !== null);
      return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length, 0) : null;
    });
  }, [roots, months]);
  const cmpSeries = parent ? parent.series : allAvg;
  const cmpLabel = parent ? `상위 분류 평균 (${parent.name})` : "전체 평균";
  const cmpLatest = cmpSeries.length ? cmpSeries[cmpSeries.length - 1] : null;
  const gap = sel?.latest && cmpLatest ? round((sel.latest / cmpLatest - 1) * 100, 1) : null;

  const relatedSuppliers = (minor: string) => derived.supplierViews.filter((s) => jobsForProcess(s.process).includes(minor));

  const spec: ChartSpec | null = sel
    ? {
        id: "wage",
        title: `${sel.name} 월평균 임금 추이 (최근 ${Math.min(span, months.length)}개월)`,
        type: "line",
        unit: "원",
        yLabel: "월평균 임금(원)",
        xLabel: "월",
        categories: months.slice(-span).map((m) => `${m.slice(2, 4)}.${m.slice(5)}`),
        series: [
          { key: "sel", label: sel.name, values: sel.series.slice(-span) },
          { key: "cmp", label: cmpLabel, values: cmpSeries.slice(-span) },
        ],
        caption: "매년 1월 임금 인상, 12월은 특근이 반영된 값입니다. 중·대분류는 하위 직종의 단순 평균입니다.",
        digits: 0,
      }
    : null;

  const toggle = (k: string) => setOpen((o) => {
    const n = new Set(o);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    return n;
  });

  const Node = ({ n }: { n: WageNode }) => {
    const k = n.path.join("›");
    const isOpen = open.has(k) || n.level === 2;
    const active = sel?.path.join("›") === k;
    return (
      <li className={`wt-node lv-${n.level}`}>
        <div className={`wt-row ${active ? "is-on" : ""}`}>
          {n.children.length ? (
            <button type="button" className="wt-fold" onClick={() => toggle(k)} aria-expanded={isOpen} aria-label={`${n.name} ${isOpen ? "접기" : "펼치기"}`}>
              {isOpen ? <LuChevronDown aria-hidden /> : <LuChevronRight aria-hidden />}
            </button>
          ) : (
            <span className="wt-fold-pad" />
          )}
          <button type="button" className="wt-name" onClick={() => setPath(n.path)} aria-pressed={active} data-node={k}>
            <span className="wt-level">{LEVEL[n.level]}</span>
            {n.name}
          </button>
          <span className="wt-val">{fmtInt(n.latest)}원</span>
          <span className="wt-yoy">
            <Delta v={n.yoy} />
          </span>
        </div>
        {n.children.length > 0 && isOpen && (
          <ul>
            {n.children.map((c) => (
              <Node key={c.name} n={c} />
            ))}
          </ul>
        )}
      </li>
    );
  };

  if (!roots.length)
    return (
      <section className="subview">
        <SubViewHead title="인건비 동향" desc="임금 데이터가 없습니다. 업로드 버튼으로 기준월·대분류·중분류·소분류·월평균 임금 파일을 올려 주세요." datasets={["laborWages"]} />
      </section>
    );

  return (
    <section className="subview" aria-label="인건비 동향">
      <SubViewHead title="인건비 동향 (직종 대·중·소 분류)" desc="협력사 가공비·인건비 인상 요청을 검토할 때 관련 직종의 임금 흐름을 함께 봅니다." datasets={["laborWages"]} asOf={months[months.length - 1]}>
        <span>단위 원/월</span>
      </SubViewHead>
      <div className="wage-layout">
        <div className="wage-tree" aria-label="직종 분류">
          <div className="wt-head">
            <span>직종 분류</span>
            <span>최근 임금</span>
            <span>전년 대비</span>
          </div>
          <ul>
            {roots.map((r) => (
              <Node key={r.name} n={r} />
            ))}
          </ul>
        </div>
        <div className="wage-main">
          {sel && (
            <div className="hl-row">
              <div className="hl">
                <span className="hl-label">{LEVEL[sel.level]} · 최근 월평균 임금</span>
                <span className="hl-value">{fmtInt(sel.latest)}원</span>
              </div>
              <div className="hl">
                <span className="hl-label">전년 같은 달 대비</span>
                <span className="hl-value">
                  <Delta v={sel.yoy} />
                </span>
              </div>
              <div className="hl">
                <span className="hl-label">{cmpLabel} 대비</span>
                <span className="hl-value">
                  <Delta v={gap} />
                </span>
              </div>
            </div>
          )}
          <div className="seg-ctl" role="radiogroup" aria-label="기간">
            {[12, 24].map((p) => (
              <button key={p} type="button" role="radio" aria-checked={span === p} className={span === p ? "is-on" : ""} onClick={() => setSpan(p)}>
                {p}개월
              </button>
            ))}
          </div>
          {spec && <Chart spec={spec} valueLabels={false} />}
          {sel?.level === 2 && (
            <p className="small muted">
              관련 협력사(공정 기준):{" "}
              {relatedSuppliers(sel.name)
                .map((s) => s.name)
                .join(", ") || "없음"}
            </p>
          )}
        </div>
      </div>
      <div className="sv-notes">
        <p>
          <LuInfo aria-hidden /> 대분류 이름은 한국표준직업분류(제8차) 대분류를 참고했고, 중·소분류는 엔진 부품 협력사 공정에 맞춰 시연용으로 구성했습니다. 협력사 공정(주조·단조·가공 등)과 소분류의 연결은 협력업체 상세에서 볼 수 있습니다.
        </p>
      </div>
    </section>
  );
}
