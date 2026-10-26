// 템플릿 ② 데이터 시각화 (표시할 차트·한 줄 개수·값 라벨·기준선은 보기 설정)
import { resolveCharts } from "../../templates/presets";
import { Chart } from "../charts/Chart";
import { Highlights } from "./shared";
import { PriceComparisonInfo, type PriceTemplateProps } from "./PriceComparisonInfo";

export function AnalyticsCharts({ result, settings, onExternalQuoteChange }: PriceTemplateProps) {
  const c = settings.chart;
  const charts = resolveCharts(result, c.charts);
  const hidden = result.charts.length - charts.length;
  return (
    <div className="tpl tpl-charts">
      <Highlights result={result} />
      {result.summary[1] && <p className="lede">{result.summary[1]}</p>}
      <div className={`chart-grid per-${c.perRow}`}>
        {charts.map((spec) => (
          <Chart key={spec.id} spec={spec} valueLabels={c.valueLabels} refLine={c.refLine} />
        ))}
      </div>
      {result.priceAnalysis && <PriceComparisonInfo analysis={result.priceAnalysis} onExternalQuoteChange={onExternalQuoteChange} />}
      <p className="tpl-note">
        기준일 {result.asOf} · {result.dataLabel} · 막대는 0에서 시작합니다. 그래프에 마우스를 올리면 값이 보이고, 각 그래프의 ‘데이터 표’에서 숫자를 확인할 수 있습니다.
        {hidden > 0 && ` 보기 설정에서 숨긴 차트 ${hidden}개가 있습니다.`}
      </p>
    </div>
  );
}
