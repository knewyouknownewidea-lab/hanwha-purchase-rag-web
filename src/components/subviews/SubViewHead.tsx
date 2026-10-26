// 하위 보기 머리: 제목·설명 + SAMPLE 표시·기준일(월)·데이터 출처·불러오기 버튼
import type { ReactNode } from "react";
import { LuFileUp } from "react-icons/lu";
import { DATASET_LABEL, type DatasetKey } from "../../data/types";
import { useStore } from "../../store/store";

/** 날짜면 '기준일', 월이면 '기준월' (헤더의 '기준일'과 같은 말을 쓴다) */
const asOfLabel = (v: string) => (/^\d{4}-\d{2}$/.test(v) ? `기준월 ${v}` : `기준일 ${v}`);

export function SubViewHead({ title, desc, datasets, asOf, asOfNote, children }: { title: string; desc: string; datasets: DatasetKey[]; asOf?: string; asOfNote?: string; children?: ReactNode }) {
  const { state, dispatch } = useStore();
  const uploaded = datasets.some((d) => state.meta.uploaded?.includes(d));
  return (
    <div className="sv-head">
      <div className="sv-title-row">
        <h3 className="sv-title">{title}</h3>
        <span className={`sv-badge ${uploaded ? "is-upload" : ""}`}>{uploaded ? "업로드 데이터" : "SAMPLE · 실제 자료 아님"}</span>
        <span className="spacer" />
        {datasets.map((d) => (
          <button key={d} type="button" className="btn btn-quiet btn-small" onClick={() => dispatch({ type: "openImport", dataset: d })} title={`${DATASET_LABEL[d]} 파일(CSV·JSON) 불러오기 — 빈 양식도 받을 수 있습니다`}>
            <LuFileUp aria-hidden /> {datasets.length > 1 ? `${DATASET_LABEL[d]} 불러오기` : "불러오기"}
          </button>
        ))}
      </div>
      <p className="sv-desc">{desc}</p>
      <p className="sv-meta">
        {asOf && (
          <span>
            {asOfLabel(asOf)}
            {asOfNote ? ` (${asOfNote})` : ""}
          </span>
        )}
        <span>출처 {datasets.map((d) => state.meta.sources[d] ?? "–").join(" · ")}</span>
        {children}
      </p>
    </div>
  );
}
