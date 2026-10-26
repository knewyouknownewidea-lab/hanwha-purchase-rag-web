// 자재-공급관리 › 업계 동향: 기사·자료 카드 목록, 부품·원자재로 거르기
import { useMemo, useState } from "react";
import { LuExternalLink, LuInfo, LuNewspaper, LuTriangleAlert } from "react-icons/lu";
import { useStore } from "../../store/store";
import { SubViewHead } from "./SubViewHead";

export function IndustryNews() {
  const { state, derived } = useStore();
  const news = useMemo(() => [...state.data.industryNews].sort((a, b) => b.date.localeCompare(a.date)), [state.data.industryNews]);
  const [item, setItem] = useState("");
  const [mat, setMat] = useState("");
  const items = useMemo(() => Array.from(new Set(news.flatMap((n) => n.items))), [news]);
  const mats = useMemo(() => Array.from(new Set(news.flatMap((n) => n.materials))), [news]);
  const shown = news.filter((n) => (!item || n.items.includes(item)) && (!mat || n.materials.includes(mat)));
  const itemName = (c: string) => derived.itemsByCode.get(c)?.name ?? c;

  if (!news.length)
    return (
      <section className="subview">
        <SubViewHead title="업계 동향" desc="업계 동향 데이터가 없습니다. 날짜·제목·요약·관련 품목·출처 링크를 담은 파일을 올려 주세요." datasets={["industryNews"]} />
      </section>
    );

  return (
    <section className="subview" aria-label="업계 동향">
      <SubViewHead title="업계 동향" desc="부품 수급·원자재·인력과 관련된 업계 소식을 모아 봅니다. 관련 품목·원자재로 거를 수 있습니다." datasets={["industryNews"]} asOf={news[0]?.date} asOfNote="가장 최근 기사">
        <span>기사는 모두 가상(SAMPLE)</span>
      </SubViewHead>
      <div className="sv-toolbar">
        <label className="field-inline">
          <span>관련 부품</span>
          <select id="news-item" value={item} onChange={(e) => setItem(e.target.value)}>
            <option value="">전체</option>
            {items.map((c) => (
              <option key={c} value={c}>
                {itemName(c)}
              </option>
            ))}
          </select>
        </label>
        <label className="field-inline">
          <span>관련 원자재</span>
          <select id="news-mat" value={mat} onChange={(e) => setMat(e.target.value)}>
            <option value="">전체</option>
            {mats.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <span className="muted small">{shown.length}건</span>
      </div>
      <ul className="news-list">
        {shown.map((n) => (
          <li key={`${n.date}|${n.title}`} className="news">
            <div className="news-top">
              <LuNewspaper aria-hidden />
              <span className="news-date">{n.date}</span>
              <span className="news-src">{n.source || "출처 미기재"}</span>
            </div>
            <h4 className="news-title">{n.title}</h4>
            {n.summary && <p className="news-sum">{n.summary}</p>}
            <div className="news-tags">
              {n.items.map((c) => (
                <span key={c} className="tag tag-item">
                  {itemName(c)}
                </span>
              ))}
              {n.materials.map((m) => (
                <span key={m} className="tag tag-mat">
                  {m}
                </span>
              ))}
              <span className="spacer" />
              {n.sourceUrl ? (
                <a href={n.sourceUrl} target="_blank" rel="noreferrer" className="news-link">
                  원문 보기 <LuExternalLink aria-hidden />
                </a>
              ) : (
                <span className="src-missing">
                  <LuTriangleAlert aria-hidden /> 출처 링크 없음
                </span>
              )}
            </div>
          </li>
        ))}
        {!shown.length && <li className="table-empty">조건에 맞는 소식이 없습니다.</li>}
      </ul>
      <div className="sv-notes">
        <p>
          <LuInfo aria-hidden /> 요약은 올린 자료에 적힌 내용을 그대로 보여 줍니다(AI가 새로 만든 문장이 아님). 출처 링크가 없는 자료는 사실 확인 전 자료로 보세요.
        </p>
      </div>
    </section>
  );
}
