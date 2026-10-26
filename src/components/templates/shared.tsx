// 템플릿 공통: 핵심 지표, 요약·위험·검토·근거, 원천 데이터
import type { ReactNode } from "react";
import { LuCircleAlert, LuClipboardCheck, LuListChecks, LuScale } from "react-icons/lu";
import type { AnalysisResult, SourceRef } from "../../lib/analysisTypes";
import { useStore } from "../../store/store";
import { fmtMoney, fmtSignedPct } from "../../lib/format";
import { StatusPill } from "../ui";
import { ScrollX } from "../ScrollX";

export function Highlights({ result }: { result: AnalysisResult }) {
  if (!result.highlights.length) return null;
  return (
    <div className="hl-row">
      {result.highlights.map((h) => (
        <div className="hl" key={h.label}>
          <span className="hl-label">{h.label}</span>
          <span className="hl-value">{h.value}</span>
        </div>
      ))}
    </div>
  );
}

export function Findings({ result, compact = false }: { result: AnalysisResult; compact?: boolean }) {
  return (
    <div className="findings">
      <section>
        <h4>
          <LuListChecks aria-hidden /> 비교 요약
        </h4>
        <ul>
          {result.summary.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </section>
      {result.risks.length > 0 && (
        <section>
          <h4>
            <LuCircleAlert aria-hidden /> 추가 검토가 필요한 위험 요소
          </h4>
          <ul className="risk-list">
            {result.risks.slice(0, compact ? 4 : 10).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </section>
      )}
      {!compact && result.reviewPoints.length > 0 && (
        <section>
          <h4>
            <LuClipboardCheck aria-hidden /> 검토할 사항
          </h4>
          <ul>
            {result.reviewPoints.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </section>
      )}
      <section className="basis">
        <h4>
          <LuScale aria-hidden /> 비교에 사용된 데이터와 평가 근거
        </h4>
        <ul>
          {result.basis.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
        <p className="small muted">
          데이터: {result.sources.filter((s) => s.ids.length).map((s) => `${s.label} ${s.ids.length}건`).join(" · ")} · 기준일 {result.asOf} · {result.dataLabel}
        </p>
      </section>
    </div>
  );
}

function SourceTable({ src }: { src: SourceRef }) {
  const { derived } = useStore();
  const ids = src.ids.slice(0, 40);
  let head: string[] = [];
  let rows: ReactNode[][] = [];
  if (src.table === "purchaseOrders") {
    head = ["발주번호", "품목", "업체", "납기 예정", "입고", "상태"];
    const set = new Set(ids);
    rows = derived.poViews.filter((p) => set.has(p.poNo)).map((p) => [p.poNo, p.itemName, p.supplierName, p.dueDate, p.receivedDate ?? "–", <StatusPill key="s" value={p.status} />]);
  } else if (src.table === "contracts") {
    head = ["계약번호", "품목", "업체", "최근 단가", "변동"];
    const set = new Set(ids);
    rows = derived.contractViews.filter((c) => set.has(c.contractId)).map((c) => [c.contractId, c.itemName, c.supplierName, fmtMoney(c.unitPrice, c.currency), fmtSignedPct(c.changeRate)]);
  } else if (src.table === "suppliers") {
    head = ["업체ID", "협력사", "평가등급", "품질", "납기 준수율"];
    rows = ids
      .map((id) => derived.supplierViews.find((s) => s.supplierId === id))
      .filter(Boolean)
      .map((s) => [s!.supplierId, s!.name, s!.evalGrade ?? "–", String(s!.qualityScore ?? "–"), s!.onTimeRate === null ? "–" : `${s!.onTimeRate}%`]);
  } else if (src.table === "inventory") {
    head = ["품목코드", "자재명", "재고/안전재고", "상태"];
    rows = ids
      .map((id) => derived.inventoryViews.find((v) => v.itemCode === id))
      .filter(Boolean)
      .map((v) => [v!.itemCode, v!.itemName, `${v!.stockQty} / ${v!.safetyStock}`, <StatusPill key="s" value={v!.status} />]);
  }
  return (
    <div className="src-block">
      <p className="src-title">
        {src.label} · {src.ids.length}건{src.ids.length > ids.length ? ` (앞 ${ids.length}건 표시)` : ""}
      </p>
      <ScrollX>
        <table className="mini-table">
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollX>
    </div>
  );
}

export function SourceRecords({ result }: { result: AnalysisResult }) {
  return (
    <div className="src-records">
      {result.sources
        .filter((s) => s.ids.length)
        .map((s) => (
          <SourceTable key={s.table} src={s} />
        ))}
    </div>
  );
}
