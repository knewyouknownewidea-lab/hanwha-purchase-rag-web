// 데이터 불러오기: CSV/JSON 업로드 → 헤더 매핑·형식 검사 → 교체 또는 병합
import { useEffect, useRef, useState } from "react";
import { LuCircleAlert, LuDownload, LuFileUp, LuX } from "react-icons/lu";
import { DATASET_LABEL, type DatasetKey } from "../data/types";
import { FIELD_TYPE_LABEL, SCHEMAS, pkFields } from "../data/schema";
import { parseCSV, toCSV } from "../lib/csv";
import { guessDataset, rowsFromJSON, validateRows, type ValidationResult } from "../lib/validate";
import { saveFile } from "../platform/runtime";
import { useStore } from "../store/store";
import { trapTab } from "./focus";
import { josa } from "../lib/format";

const BASIC: DatasetKey[] = ["suppliers", "purchaseOrders", "contracts", "inventory", "items", "bom"];
const MARKET: DatasetKey[] = ["materialPrices", "fxRates", "laborWages", "competitorSupply", "industryNews"];

export function ImportDialog() {
  const { state, dispatch } = useStore();
  const open = state.importFor !== null;
  const [dataset, setDataset] = useState<DatasetKey>("suppliers");
  const [file, setFile] = useState<{ name: string; raw: Record<string, unknown>[] } | null>(null);
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"replace" | "merge">("merge");
  const [hint, setHint] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setDataset(state.importFor as DatasetKey);
      setFile(null);
      setResult(null);
      setError(null);
      setHint(null);
      setTimeout(() => dialogRef.current?.focus(), 0);
    }
  }, [open, state.importFor]);

  useEffect(() => {
    if (file) setResult(validateRows(dataset, file.raw, state.data));
  }, [dataset, file, state.data]);

  if (!open) return null;
  const close = () => dispatch({ type: "openImport", dataset: null });
  const isJson = !!file && /\.json$/i.test(file.name);
  const keyLabel = pkFields(SCHEMAS[dataset])
    .map((k) => SCHEMAS[dataset].fields.find((f) => f.key === k)?.label ?? k)
    .join("+");

  const readFile = async (f: File) => {
    setError(null);
    setHint(null);
    try {
      const text = await f.text();
      const isJSON = /\.json$/i.test(f.name) || text.trim().startsWith("[") || text.trim().startsWith("{");
      const raw = isJSON ? rowsFromJSON(text, dataset) : (parseCSV(text) as Record<string, unknown>[]);
      if (!raw.length) throw new Error("데이터 행이 없습니다");
      const guess = guessDataset(Object.keys(raw[0]));
      if (guess && guess !== dataset) setHint(`열 이름으로 보면 '${DATASET_LABEL[guess]}' 데이터 같습니다.`);
      setFile({ name: f.name, raw });
    } catch (e) {
      setFile(null);
      setResult(null);
      setError(`파일을 읽지 못했습니다: ${(e as Error).message}. CSV(첫 줄은 열 이름) 또는 JSON 배열 형식인지 확인해 주세요.`);
    }
  };

  const apply = () => {
    if (!result || !file || !result.rows.length) return;
    dispatch({ type: "replaceData", dataset, rows: result.rows, source: file.name, mode });
    dispatch({
      type: "toast",
      text: `${DATASET_LABEL[dataset]} ${result.rows.length}행을 ${mode === "replace" ? "교체" : "병합"}했습니다. 지표를 다시 계산했고, 이 브라우저에 저장해 새로고침해도 유지됩니다.`,
    });
    close();
  };

  const downloadTemplate = async () => {
    const schema = SCHEMAS[dataset];
    const csv = toCSV(
      schema.fields.map((f) => ({ key: f.key, label: f.label })),
      [],
    );
    const r = await saveFile(`${DATASET_LABEL[dataset].replace(/[()\s]/g, "")}_양식.csv`, csv, "text/csv;charset=utf-8");
    if (r === "unavailable") dispatch({ type: "toast", text: "이 화면에서는 파일 저장을 쓸 수 없습니다. 아래 필드 안내를 참고해 주세요.", tone: "warn" });
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          trapTab(e, dialogRef.current);
        }}
      >
        <div className="modal-head">
          <h2 id="import-title">데이터 불러오기</h2>
          <button type="button" className="icon-btn" onClick={close} aria-label="닫기">
            <LuX aria-hidden />
          </button>
        </div>
        <div className="modal-body">
          <div className="field-row">
            <label htmlFor="import-dataset">데이터 종류</label>
            <select id="import-dataset" value={dataset} onChange={(e) => setDataset(e.target.value as DatasetKey)}>
              <optgroup label="구매 기본 데이터">
                {BASIC.map((d) => (
                  <option key={d} value={d}>
                    {DATASET_LABEL[d]}
                  </option>
                ))}
              </optgroup>
              <optgroup label="시세·인건비·동향">
                {MARKET.map((d) => (
                  <option key={d} value={d}>
                    {DATASET_LABEL[d]}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>

          <label
            className={`dropzone ${drag ? "is-drag" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              const f = e.dataTransfer.files?.[0];
              if (f) readFile(f);
            }}
          >
            <LuFileUp aria-hidden />
            <span>{file ? file.name : "CSV 또는 JSON 파일을 끌어다 놓거나 눌러서 선택"}</span>
            <input id="import-file" type="file" accept=".csv,.json,text/csv,application/json" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} />
          </label>
          {hint && <p className="note-warn">{hint} 데이터 종류를 확인해 주세요.</p>}
          {error && (
            <p className="note-bad" role="alert">
              <LuCircleAlert aria-hidden /> {error}
            </p>
          )}

          {result && (
            <div className="validation">
              <div className="validation-stats">
                <span>
                  전체 <b>{result.total}</b>행
                </span>
                <span className="ok">
                  반영 가능 <b>{result.rows.length}</b>행
                </span>
                <span className={result.errors.length ? "bad" : ""}>
                  오류 <b>{result.errors.length}</b>건
                </span>
                <span className={result.warnings.length ? "warn" : ""}>
                  경고 <b>{result.warnings.length}</b>건
                </span>
              </div>
              <p className="small">
                연결된 열: {result.mapped.map((m) => `${m.source}→${m.label}`).join(", ") || "없음"}
                {result.unmapped.length ? ` · 사용하지 않는 열: ${result.unmapped.join(", ")}` : ""}
              </p>
              {(result.errors.length > 0 || result.warnings.length > 0) && (
                <p className="small muted">
                  {isJson ? "번호는 JSON 배열의 몇 번째 항목인지입니다." : "행 번호는 파일을 엑셀로 열었을 때의 행 번호입니다 (1행 = 열 이름)."}
                  {result.errors.length > 0 ? " 오류가 있는 행은 반영하지 않습니다." : ""}
                </p>
              )}
              {[...result.errors.slice(0, 6).map((i) => ({ ...i, t: "bad" })), ...result.warnings.slice(0, 4).map((i) => ({ ...i, t: "warn" }))].map((i, k) => (
                <p key={k} className={`issue issue-${i.t}`}>
                  {i.row ? (isJson ? `${i.row}번째 항목` : `${i.row + 1}행`) : "파일"}
                  {i.field ? ` · ${i.field}` : ""}: {i.message}
                </p>
              ))}
              {result.errors.length > 6 && <p className="small muted">오류 {result.errors.length - 6}건 더 있음</p>}
              <fieldset className="import-mode">
                <legend>반영 방식</legend>
                <label>
                  <input type="radio" name="import-mode" id="mode-merge" checked={mode === "merge"} onChange={() => setMode("merge")} /> 병합 (같은 {keyLabel}
                  {josa(keyLabel, "이면/면")} 새 값으로 바꾸고, 나머지 행은 그대로 둠)
                </label>
                <label>
                  <input type="radio" name="import-mode" id="mode-replace" checked={mode === "replace"} onChange={() => setMode("replace")} /> 교체 (기존 {DATASET_LABEL[dataset]} 전체를 이 파일 내용으로 바꿈)
                </label>
              </fieldset>
            </div>
          )}

          <details className="schema-help">
            <summary>필드 안내 · {DATASET_LABEL[dataset]}</summary>
            <table>
              <thead>
                <tr>
                  <th>열 이름</th>
                  <th>필드</th>
                  <th>형식</th>
                  <th>필수</th>
                </tr>
              </thead>
              <tbody>
                {SCHEMAS[dataset].fields.map((f) => (
                  <tr key={f.key}>
                    <td>{f.label}</td>
                    <td className="code">{f.key}</td>
                    <td>
                      {FIELD_TYPE_LABEL[f.type]}
                      {f.hint ? ` · ${f.hint}` : ""}
                    </td>
                    <td>{f.required ? "필수" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small muted">
              한 행을 구분하는 열: {pkFields(SCHEMAS[dataset]).map((k) => SCHEMAS[dataset].fields.find((f) => f.key === k)?.label ?? k).join(" + ")} · 협력사는 업체ID, 품목은 품목코드로 다른 표와 연결됩니다.
            </p>
          </details>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-quiet" onClick={downloadTemplate}>
            <LuDownload aria-hidden /> 빈 양식 받기
          </button>
          <span className="spacer" />
          <button type="button" className="btn btn-quiet" onClick={close}>
            취소
          </button>
          <button type="button" className="btn btn-primary" onClick={apply} disabled={!result || !result.rows.length}>
            {result ? `${result.rows.length}행 반영` : "반영"}
          </button>
        </div>
      </div>
    </div>
  );
}
