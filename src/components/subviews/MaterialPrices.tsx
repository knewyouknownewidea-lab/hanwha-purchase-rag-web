// 원가-계약 › 원자재 시세: 국제·국내 시세를 원/kg로 맞춰 비교, 품목 계약 단가 변동률과 나란히
import { useMemo, useState } from "react";
import { LuInfo } from "react-icons/lu";
import { useStore } from "../../store/store";
import { Chart } from "../charts/Chart";
import type { ChartSpec } from "../../lib/analysisTypes";
import { fmtInt, fmtSignedPct } from "../../lib/format";
import { buildMaterialSeries, type MaterialSeries } from "../../lib/market";
import { SubViewHead } from "./SubViewHead";
import { ScrollX } from "../ScrollX";

const PERIODS = [6, 12, 24];

function Delta({ v }: { v: number | null }) {
  if (v === null) return <span className="muted">–</span>;
  return <span className={v > 0 ? "delta-up" : v < 0 ? "delta-down" : ""}>{fmtSignedPct(v)}</span>;
}

export function MaterialPrices() {
  const { state, derived } = useStore();
  const series = useMemo(() => buildMaterialSeries(state.data.materialPrices, state.data.fxRates), [state.data.materialPrices, state.data.fxRates]);
  const [period, setPeriod] = useState(12);
  const [pick, setPick] = useState<string | null>(null);
  const cur: MaterialSeries | undefined = series.find((s) => s.material === pick) ?? series[0];
  const latest = series.map((s) => s.latestMonth).filter(Boolean).sort().pop() ?? "–";

  const spec: ChartSpec | null = cur
    ? {
        id: "mat",
        title: `${cur.material} 시세 추이 (원/kg, 최근 ${Math.min(period, cur.months.length)}개월)`,
        type: "line",
        unit: "원/kg",
        yLabel: "원/kg",
        xLabel: "월",
        categories: cur.months.slice(-period).map((m) => `${m.slice(2, 4)}.${m.slice(5)}`),
        series: [
          { key: "dom", label: "국내 시세", values: cur.domestic.slice(-period) },
          { key: "intl", label: "국제 시세(원화 환산)", values: cur.intlKrw.slice(-period) },
        ],
        caption: `국제 시세(${cur.intlUnit})를 그 달의 월평균 원/달러 환율로 바꾸고 1,000으로 나눠 원/kg로 맞췄습니다.`,
        digits: 0,
      }
    : null;

  // 품목 ↔ 소재 ↔ 계약 단가 변동률
  const links = useMemo(
    () =>
      [...derived.itemsByCode.values()]
        .filter((i) => i.materials?.length)
        .map((i) => ({
          item: i,
          mats: (i.materials ?? []).map((m) => ({ m, s: series.find((x) => x.material === m) })),
          contracts: derived.contractViews.filter((c) => c.itemCode === i.itemCode),
        })),
    [derived, series],
  );

  if (!series.length)
    return (
      <section className="subview">
        <SubViewHead title="원자재 시세" desc="원자재 시세 데이터가 없습니다. 업로드 버튼으로 시세 파일(기준월·원자재·시장·가격·단위·통화)을 올려 주세요." datasets={["materialPrices", "fxRates"]} />
      </section>
    );

  return (
    <section className="subview" aria-label="원자재 시세">
      <SubViewHead title="원자재 국제·국내 시세" desc="부품별 주요 소재의 시세 흐름을 원/kg로 맞춰 봅니다. 단가 협상 때 계약 단가 변동률과 함께 참고하세요." datasets={["materialPrices", "fxRates"]} asOf={latest}>
        <span>표시 단위 원/kg (KRW)</span>
      </SubViewHead>
      <div className="sv-toolbar">
        <div className="seg-ctl" role="radiogroup" aria-label="기간">
          {PERIODS.map((p) => (
            <button key={p} type="button" role="radio" aria-checked={period === p} className={period === p ? "is-on" : ""} onClick={() => setPeriod(p)}>
              {p}개월
            </button>
          ))}
        </div>
        <div className="mat-chips" role="radiogroup" aria-label="원자재 선택">
          {series.map((s) => (
            <button key={s.material} type="button" role="radio" aria-checked={cur?.material === s.material} className={`chip-btn ${cur?.material === s.material ? "is-on" : ""}`} onClick={() => setPick(s.material)}>
              {s.material}
            </button>
          ))}
        </div>
      </div>
      {spec && <Chart spec={spec} valueLabels={false} />}
      {cur?.notes.map((n) => (
        <p key={n} className="note-warn">
          {n}
        </p>
      ))}
      <ScrollX>
        <table className="data-table mat-table" aria-label="원자재 시세 요약">
          <thead>
            <tr>
              <th>원자재</th>
              <th className="num">국내 시세 (원/kg)</th>
              <th className="num" title="국제 시세를 월평균 환율로 원/kg 환산">국제 시세 환산 (원/kg)</th>
              <th className="num">국제 시세 원래 값</th>
              <th className="num has-hint" title="국내 시세 기준">전월 대비</th>
              <th className="num has-hint" title="국내 시세 기준, 1년 전 같은 달과 비교">전년 같은 달 대비</th>
              <th className="num has-hint" title="국내 시세 기준, 3개월 전과 비교">3개월 추세</th>
            </tr>
          </thead>
          <tbody>
            {series.map((s) => (
              <tr key={s.material} className={cur?.material === s.material ? "is-selected" : ""} onClick={() => setPick(s.material)} tabIndex={0} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setPick(s.material))}>
                <td>
                  <b>{s.material}</b> <span className="muted small">{s.latestMonth}</span>
                </td>
                <td className="num">{fmtInt(s.latest.domestic)}</td>
                <td className="num">{fmtInt(s.latest.intl)}</td>
                <td className="num">
                  {s.intlRaw.length ? `${fmtInt(s.intlRaw[s.intlRaw.length - 1])} ${s.intlUnit}` : "–"}
                </td>
                <td className="num">
                  <Delta v={s.mom.domestic} />
                </td>
                <td className="num">
                  <Delta v={s.yoy.domestic} />
                </td>
                <td className="num">
                  <Delta v={s.trend3.domestic} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollX>

      <div className="sv-list-head">
        <h4>품목별 주요 소재와 계약 단가 변동 (단가 협상 참고)</h4>
      </div>
      <ScrollX>
        <table className="data-table link-table" aria-label="품목별 소재와 계약 단가 변동">
          <thead>
            <tr>
              <th>품목</th>
              <th>주요 소재 · 전년 같은 달 대비 (국내)</th>
              <th>계약 단가 변동률 (직전 → 최근 계약)</th>
            </tr>
          </thead>
          <tbody>
            {links.map(({ item, mats, contracts }) => (
              <tr key={item.itemCode}>
                <td>
                  <span className="name-cell">
                    <span className="name">{item.name}</span>
                    <span className="code">{item.itemCode}</span>
                  </span>
                </td>
                <td>
                  <span className="mat-tags">
                    {mats.map(({ m, s }) => (
                      <span key={m} className="mat-tag">
                        {m} {s ? <Delta v={s.yoy.domestic} /> : <span className="muted">시세 없음</span>}
                      </span>
                    ))}
                  </span>
                </td>
                <td>
                  <span className="mat-tags">
                    {contracts.length ? (
                      contracts.map((c) => (
                        <span key={c.contractId} className="mat-tag">
                          {c.supplierName} <Delta v={c.changeRate} />
                        </span>
                      ))
                    ) : (
                      <span className="muted">계약 없음</span>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollX>
      <div className="sv-notes">
        <p>
          <LuInfo aria-hidden /> 소재 시세와 계약 단가를 나란히 보여 줄 뿐, 단가 변동의 원인을 판단하지 않습니다. 부품별 주요 소재는 품목 마스터의 ‘주요 소재’ 열(일반적인 예시)이며 실제 도면 재질로 바꿀 수 있습니다.
        </p>
      </div>
    </section>
  );
}
