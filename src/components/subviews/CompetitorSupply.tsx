// 자재-공급관리 › 경쟁사 공급 동향: 부품별 경쟁사 → 공급처 → 수요, 우리 협력사가 경쟁사에도 공급하면 '공급 경쟁'
import { useMemo, useState } from "react";
import { LuArrowRight, LuExternalLink, LuInfo, LuTriangleAlert } from "react-icons/lu";
import { useStore } from "../../store/store";
import { josa } from "../../lib/format";
import { SubViewHead } from "./SubViewHead";

export function CompetitorSupply() {
  const { state, derived, dispatch } = useStore();
  const rows = state.data.competitorSupply;
  const [item, setItem] = useState("");
  const items = useMemo(() => Array.from(new Set(rows.map((r) => r.itemCode))), [rows]);
  const ours = (r: (typeof rows)[number]) => {
    const byId = r.supplierId ? derived.suppliersById.get(r.supplierId) : undefined;
    return byId ?? derived.supplierViews.find((s) => s.name === r.supplierName);
  };
  const shown = rows.filter((r) => !item || r.itemCode === item);
  const contested = shown.filter((r) => ours(r));
  const itemName = (c: string) => derived.itemsByCode.get(c)?.name ?? c;
  const latestDate = rows.reduce<string | undefined>((m, r) => (r.date && (!m || r.date > m) ? r.date : m), undefined);

  if (!rows.length)
    return (
      <section className="subview">
        <SubViewHead title="경쟁사 공급 동향" desc="경쟁사 공급 동향 데이터가 없습니다. 공시·보도 등 공개 자료를 정리해 업로드하세요(출처 링크 포함)." datasets={["competitorSupply"]} />
      </section>
    );

  return (
    <section className="subview" aria-label="경쟁사 공급 동향">
      <SubViewHead
        title="경쟁사 부품 수요·공급처"
        desc="공개 자료로 확인한 경쟁사의 부품 수요와 공급처입니다. 우리 협력사가 경쟁사에도 공급하면 물량 경합 위험을 검토하세요."
        datasets={["competitorSupply"]}
        asOf={latestDate}
        asOfNote="가장 최근 확인일"
      >
        <span>회사명은 모두 가상(SAMPLE)</span>
      </SubViewHead>
      <div className="sv-toolbar">
        <label className="field-inline">
          <span>부품</span>
          <select id="comp-item" value={item} onChange={(e) => setItem(e.target.value)}>
            <option value="">전체 ({rows.length}건)</option>
            {items.map((c) => (
              <option key={c} value={c}>
                {itemName(c)} ({c})
              </option>
            ))}
          </select>
        </label>
        <span className={`pill ${contested.length ? "pill-warn" : "pill-ok"}`} title="공급 경쟁 = 우리 협력사가 경쟁사에도 같은 부품을 공급하는 건 (물량·납기 경합 가능성)">공급 경쟁 {contested.length}건</span>
      </div>
      <ul className="rel-list">
        {shown.map((r) => {
          const our = ours(r);
          return (
            <li key={`${r.competitor}|${r.itemCode}|${r.supplierName}`} className={`rel ${our ? "is-contested" : ""}`}>
              <div className="rel-flow">
                <span className="rel-node rel-comp">{r.competitor}</span>
                <LuArrowRight aria-hidden className="rel-arrow" />
                <span className="rel-node rel-item">{itemName(r.itemCode)}</span>
                <LuArrowRight aria-hidden className="rel-arrow" />
                <span className="rel-node rel-sup">
                  {r.supplierName}
                  {our && <span className="rel-ours">우리 협력사</span>}
                </span>
              </div>
              <p className="rel-demand">{r.demand || "수요 내용 기록 없음"}</p>
              <p className="rel-meta">
                {r.period && <span>시기 {r.period}</span>}
                {r.date && <span>확인일 {r.date}</span>}
                <span>출처 {r.source || "–"}</span>
                {r.sourceUrl ? (
                  <a href={r.sourceUrl} target="_blank" rel="noreferrer">
                    원문 <LuExternalLink aria-hidden />
                  </a>
                ) : (
                  <span className="src-missing">
                    <LuTriangleAlert aria-hidden /> 출처 링크 없음
                  </span>
                )}
              </p>
              {our && (
                <p className="rel-warn">
                  <b>공급 경쟁</b> · {our.name}
                  {josa(our.name, "이/가")} 경쟁사에도 같은 부품을 공급합니다. 물량·납기 경합 가능성을 검토하세요.{" "}
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      dispatch({ type: "subView", tab: "suppliers", view: "list" });
                      dispatch({ type: "selectRow", tab: "suppliers", rowKey: our.supplierId, supplierId: our.supplierId });
                      dispatch({ type: "focusData" });
                    }}
                  >
                    협력사 정보 보기
                  </button>
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <div className="sv-notes">
        <p>
          <LuInfo aria-hidden /> 공시·보도·업체 홈페이지 같은 공개 자료만 정리합니다. 출처 링크가 없는 항목은 사실 확인 전 자료로 보세요.
        </p>
      </div>
    </section>
  );
}
