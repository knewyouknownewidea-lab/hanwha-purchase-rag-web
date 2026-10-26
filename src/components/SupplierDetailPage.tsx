// 협력사 상세페이지 (새 창, ?supplier=SUP-001): 기본정보 · 평가점수 추이 · 공급품목 · 관련 계약과 단가. 읽기 전용이다.
import { useEffect } from "react";
import { halfLabel } from "../data/types";
import { useStore } from "../store/store";
import { fmtDate, fmtNum, fmtPct, fmtSignedPct } from "../lib/format";
import { EVAL_CONFIG } from "../lib/evaluation";
import { GradeBadge, EmptyState } from "./ui";
import { ScoreTrend, sortHistory } from "./ScoreTrend";
import { priceText, sortContracts } from "./ContractPrices";

export function SupplierDetailPage({ supplierId }: { supplierId: string }) {
  const { state, derived } = useStore();
  const s = derived.supplierViews.find((x) => x.supplierId === supplierId);
  useEffect(() => {
    document.title = s ? `${s.name} 상세 · 협력사` : "협력사 상세";
  }, [s]);
  const badge = state.meta.isSample ? "SAMPLE · 실제 자료 아님" : state.meta.label;
  if (!s)
    return (
      <main className="detail-page">
        <EmptyState title="협력사를 찾지 못했습니다">
          {supplierId} 협력사가 현재 데이터에 없습니다. 원래 창에서 협력사명을 다시 눌러 주세요.
        </EmptyState>
      </main>
    );
  const ev = derived.evaluations.get(s.supplierId);
  const del = derived.supplierDelivery.get(s.supplierId);
  const contracts = sortContracts(derived.contractViews.filter((c) => c.supplierId === s.supplierId));
  const item = (code: string) => derived.itemsByCode.get(code);
  const history = sortHistory(s.evalHistory);
  const th = EVAL_CONFIG.priceIncreaseThreshold;
  const fields: [string, React.ReactNode][] = [
    ["업체 ID", s.supplierId],
    ["평가등급(산정)", <><GradeBadge grade={ev?.grade ?? s.evalGrade} /> {fmtNum(ev?.total ?? s.evalScore ?? null)}점</>],
    ["심사 등급(입력)", s.auditGrade ? `${s.auditGrade} · ${s.lastAuditDate ?? "심사일 미등록"}` : "–"],
    ["공정 · 지역", `${s.process ?? "–"} · ${s.region ?? "–"}`],
    ["납기 준수율", del ? `${fmtPct(s.onTimeRate)} (마감 ${del.evaluated}건 중 기한 내 ${del.onTime}건)` : fmtPct(s.onTimeRate)],
    ["품질 점수 · 불량률", `${fmtNum(s.qualityScore ?? null, 0)}점 · ${fmtPct(s.defectRate ?? null)}`],
    ["최근 거래일 · 발주", `${fmtDate(s.tradeDate)} · ${s.poCount}건`],
  ];
  return (
    <main className="detail-page" data-supplier={s.supplierId}>
      <header className="detail-head">
        <div>
          <p className="detail-eyebrow">협력사 상세 · <span className="sv-badge">{badge}</span> · 기준일 {state.meta.asOf}</p>
          <h1>{s.name}</h1>
        </div>
        <button type="button" className="btn btn-quiet" onClick={() => window.close()}>창 닫기</button>
      </header>

      <section className="detail-sec" aria-labelledby="d-basic">
        <h2 id="d-basic">기본정보</h2>
        <dl className="detail-fields">
          {fields.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="detail-sec" aria-labelledby="d-trend">
        <h2 id="d-trend">평가점수 추이</h2>
        <ScoreTrend history={s.evalHistory} size="lg" />
        {history.length > 0 && (
          <div className="detail-table-wrap">
            <table className="data-table detail-table">
              <thead><tr><th>평가 시점</th><th>등급</th><th>종합점수</th><th>변동 사유</th></tr></thead>
              <tbody>
                {history.map((h) => (
                  <tr key={`${h.year}-${h.half ?? 0}`}>
                    <td>{halfLabel(h)}</td>
                    <td><GradeBadge grade={h.grade} /></td>
                    <td className="num">{h.score}</td>
                    <td className="wrap">{h.reason || "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="detail-note">협력업체 데이터의 평가 이력(반기별)만 표시합니다. 평가일자가 없어 반기 단위로 그립니다.</p>
      </section>

      <section className="detail-sec" aria-labelledby="d-items">
        <h2 id="d-items">공급품목</h2>
        {s.items.length ? (
          <div className="detail-table-wrap">
            <table className="data-table detail-table">
              <thead><tr><th>품목</th><th>규격</th><th>분류</th><th>단위</th></tr></thead>
              <tbody>
                {s.items.map((code) => (
                  <tr key={code}>
                    <td><span className="name">{item(code)?.name ?? code}</span> <span className="code">{code}</span></td>
                    <td className="wrap">{item(code)?.spec ?? "–"}</td>
                    <td>{item(code)?.category ?? "–"}</td>
                    <td>{item(code)?.unit ?? "단위 미등록"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="detail-note">등록된 공급품목이 없습니다.</p>
        )}
      </section>

      <section className="detail-sec" aria-labelledby="d-contracts">
        <h2 id="d-contracts">관련 계약과 단가 <span className="detail-count">{contracts.length}건</span></h2>
        {contracts.length ? (
          <div className="detail-table-wrap">
            <table className="data-table detail-table">
              <thead><tr><th>계약번호</th><th>품목</th><th>계약단가 (통화/단위)</th><th>과거 단가</th><th>변동률</th><th>계약 기간</th><th>인도 · 결제 조건</th></tr></thead>
              <tbody>
                {contracts.map((c) => (
                  <tr key={c.contractId}>
                    <td><span className="code">{c.contractId}</span></td>
                    <td>{c.itemName}</td>
                    <td className="num">{priceText(c, item(c.itemCode)?.unit)}</td>
                    <td className="num">{c.prevUnitPrice != null ? priceText({ unitPrice: c.prevUnitPrice, currency: c.currency }, item(c.itemCode)?.unit) : "–"}</td>
                    <td className={`num ${(c.changeRate ?? 0) >= th ? "delta-up" : ""}`}>{fmtSignedPct(c.changeRate)}</td>
                    <td>{c.startDate ?? "–"} ~ {c.endDate ?? "–"}{c.expiresInDays !== null && c.expiresInDays >= 0 ? ` (종료까지 ${c.expiresInDays}일)` : ""}</td>
                    <td className="wrap">{[c.deliveryTerms, c.paymentTerms].filter(Boolean).join(" · ") || "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="detail-note">이 협력사와 맺은 계약이 계약 단가 데이터에 없습니다.</p>
        )}
      </section>
      <p className="detail-note">업체 선정은 자동 확정하지 않습니다. 최종 판단은 담당자가 합니다.</p>
    </main>
  );
}
