// 분석 결과창: 상단 고정(템플릿 4종 · 보기 설정 · 결과 제목과 작업 버튼) + 본문(선택한 템플릿)
// 같은 결과를 템플릿만 바꿔 다시 그린다(재분석 없음)
import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { LuChevronDown, LuChevronUp, LuDatabase, LuInfo, LuDownload, LuFileDown, LuFileSpreadsheet, LuHistory, LuPrinter, LuRefreshCw, LuSheet, LuSlidersHorizontal, LuSparkles, LuTriangleAlert } from "react-icons/lu";
import type { AnalysisResult, TemplateId } from "../lib/analysisTypes";
import { resultName, useStore } from "../store/store";
import { useAgent } from "../store/agent";
import { toCSV } from "../lib/csv";
import { buildXlsx, exportFileName, XLSX_MIME } from "../lib/xlsx";
import { resultSheets } from "../lib/exporters";
import { canPrint, printReport, reportDocument, saveFile, saveMessage } from "../platform/runtime";
import { HistoryPanel } from "./HistoryPanel";
import { AiChatIcon } from "./ChatWidget";
import { BUILT_IN_PRESETS, matchPreset, type ViewSettings } from "../templates/presets";
import { TemplateBar } from "./TemplateBar";
import { ViewSettingsPanel } from "./ViewSettingsPanel";
import { ComparisonTable } from "./templates/ComparisonTable";
import { AnalyticsCharts } from "./templates/AnalyticsCharts";
import { SupplierScoreCard } from "./templates/SupplierScoreCard";
import { AnalysisReport } from "./templates/AnalysisReport";
import { SourceRecords } from "./templates/shared";
import { EmptyState } from "./ui";
import { SelectionDetail, useSelectionTitle } from "./SelectionDetail";

const RENDERERS: Record<Exclude<TemplateId, "report">, ComponentType<{ result: AnalysisResult; settings: ViewSettings }>> = {
  table: ComparisonTable,
  chart: AnalyticsCharts,
  cards: SupplierScoreCard,
};

function csvOf(result: AnalysisResult) {
  const headers = [
    ...(result.rows.some((r) => r.rank) ? [{ key: "__rank", label: result.rankLabel ?? "순서" }] : []),
    { key: "__label", label: "대상" },
    { key: "__sub", label: "코드" },
    ...result.columns.map((c) => ({ key: c.key, label: c.label })),
    { key: "__currency", label: "통화" },
    { key: "__strengths", label: "강점" },
    { key: "__risks", label: "위험 요소" },
  ];
  const rows = result.rows.map((r) => ({
    __rank: r.rank ?? "",
    __label: r.label,
    __sub: r.sub ?? "",
    ...r.values,
    __currency: r.currency ?? "",
    __strengths: r.strengths.join(" / "),
    __risks: r.risks.join(" / "),
  }));
  return toCSV(headers, rows);
}

function ExportMenu({ onXlsx, onCsv }: { onXlsx: () => void; onCsv: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className={`btn btn-quiet export-toggle ${open ? "is-on" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" title="표 데이터를 파일로 내보내기">
        <LuDownload aria-hidden /> 내보내기 <LuChevronDown aria-hidden />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            data-export="xlsx"
            onClick={() => {
              setOpen(false);
              onXlsx();
            }}
          >
            <LuFileSpreadsheet aria-hidden /> 엑셀 (.xlsx) <small>결과 표 + 조건·근거 시트</small>
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            data-export="csv"
            onClick={() => {
              setOpen(false);
              onCsv();
            }}
          >
            <LuSheet aria-hidden /> CSV <small>다른 프로그램에 붙여 넣기용</small>
          </button>
        </div>
      )}
    </div>
  );
}

export function ResultPanel() {
  const { state, dispatch } = useStore();
  const { choose, rerun } = useAgent();
  const [showSrc, setShowSrc] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const reportRef = useRef<HTMLElement>(null);
  const result = state.view.resultId ? state.results[state.view.resultId] : null;
  const tpl = result ? state.view.template ?? result.recommended : null;
  const stale = result && result.dataId !== state.meta.dataId;
  const name = result ? resultName(state, result) : "";
  const fileBase = result ? `${name.replace(/[\\/:*?"<>|\s]+/g, "_")}_${result.asOf}` : "";
  const allPresets = [...BUILT_IN_PRESETS, ...state.userPresets];
  const presetId = matchPreset(state.settings, allPresets);
  const presetName = presetId === "default" ? "기본" : allPresets.find((p) => p.id === presetId)?.name ?? "사용자 설정";
  const closeSettings = useCallback(() => setShowSettings(false), []);
  const closeHistory = useCallback(() => setShowHistory(false), []);
  const historyCount = Object.keys(state.results).length;
  const selTitle = useSelectionTitle();
  const showDetail = !!selTitle && state.detailOpen;

  const exportCSV = async () => {
    if (!result) return;
    const r = await saveFile(`${fileBase}.csv`, csvOf(result), "text/csv;charset=utf-8");
    dispatch({ type: "toast", text: saveMessage(r, "CSV 파일"), tone: r === "saved" ? "ok" : "warn" });
  };
  const exportXlsx = async () => {
    if (!result) return;
    const bytes = buildXlsx(resultSheets(result, name), name);
    const r = await saveFile(exportFileName("분석결과", name), bytes, XLSX_MIME);
    dispatch({ type: "toast", text: saveMessage(r, "엑셀 파일"), tone: r === "saved" ? "ok" : "warn" });
  };
  const exportReport = async () => {
    if (!result) return;
    if (tpl !== "report") choose(result.id, "report");
    if (canPrint()) {
      setTimeout(printReport, 80);
      return;
    }
    setTimeout(async () => {
      const html = reportDocument(result.title, reportRef.current?.outerHTML ?? "");
      const r = await saveFile(`${fileBase}_보고서.html`, html, "text/html;charset=utf-8");
      dispatch({ type: "toast", text: r === "saved" ? "보고서를 HTML로 저장했습니다. 브라우저에서 열어 PDF로 인쇄할 수 있습니다" : r === "declined" ? "저장을 취소했습니다" : "이 화면에서는 파일 저장을 쓸 수 없습니다", tone: r === "saved" ? "ok" : "warn" });
    }, 80);
  };

  const Renderer = tpl && tpl !== "report" ? RENDERERS[tpl] : null;

  return (
    <>
      <div className="panel-head result-top">
        <div className="panel-title-row">
          <h2 className="panel-title">분석 결과</h2>
          {selTitle && (
            <button
              type="button"
              className={`btn btn-quiet detail-toggle ${showDetail ? "is-on" : ""}`}
              onClick={() => dispatch({ type: "detailOpen", open: !state.detailOpen })}
              aria-expanded={showDetail}
              aria-controls="selection-detail"
              title={showDetail ? "선택 정보 접기" : "선택한 협력사·부품 정보 펼치기"}
            >
              <LuInfo aria-hidden /> <span className="detail-toggle-name">{selTitle}</span> {showDetail ? <LuChevronUp aria-hidden /> : <LuChevronDown aria-hidden />}
            </button>
          )}
          <span className="spacer" />
          <button
            type="button"
            className={`btn btn-quiet history-toggle ${showHistory ? "is-on" : ""}`}
            onClick={() => {
              setShowHistory((v) => !v);
              setShowSettings(false);
            }}
            aria-expanded={showHistory}
            aria-haspopup="dialog"
            title="지난 분석 결과를 이름으로 찾아 다시 보기"
          >
            <LuHistory aria-hidden /> 분석 이력 <span className="count-badge">{historyCount}</span>
          </button>
          <button
            type="button"
            className={`btn btn-quiet vs-toggle ${showSettings ? "is-on" : ""}`}
            onClick={() => {
              setShowSettings((v) => !v);
              setShowHistory(false);
            }}
            aria-expanded={showSettings}
            aria-haspopup="dialog"
            disabled={!result}
            title={result ? "템플릿 레이아웃과 프리셋" : "분석 결과가 있으면 설정할 수 있습니다"}
          >
            <LuSlidersHorizontal aria-hidden /> 보기 설정 <span className="vs-current">{presetName}</span>
          </button>
        </div>
        <TemplateBar result={result} active={tpl} onChoose={(t) => result && choose(result.id, t)} />
        {!result && <p className="tpl-hint">챗봇에 질문하면 결과 형식을 선택할 수 있습니다.</p>}
        {result && (
          <div className="result-titlebar">
            <div className="result-titles">
              <p className="eyebrow">{result.kindLabel}</p>
              <h3 title={name !== result.title ? `원래 제목: ${result.title}` : undefined}>{name}</h3>
            </div>
            <div className="result-actions">
              <button type="button" className="btn btn-quiet" onClick={() => rerun(result)} title="현재 데이터로 다시 분석">
                <LuRefreshCw aria-hidden /> 다시 분석
              </button>
              <ExportMenu onXlsx={exportXlsx} onCsv={exportCSV} />
              <button type="button" className="btn btn-quiet" onClick={exportReport} title={canPrint() ? "보고서 인쇄 또는 PDF 저장" : "보고서를 HTML로 저장"}>
                {canPrint() ? <LuPrinter aria-hidden /> : <LuFileDown aria-hidden />} {canPrint() ? "보고서 인쇄" : "보고서 저장"}
              </button>
              <button type="button" className={`btn btn-quiet ${showSrc ? "is-on" : ""}`} onClick={() => setShowSrc(!showSrc)} aria-pressed={showSrc} title="이 결과를 계산한 원천 레코드">
                <LuDatabase aria-hidden /> 근거 데이터
              </button>
            </div>
          </div>
        )}
        {showSettings && tpl && <ViewSettingsPanel result={result} template={tpl} onClose={closeSettings} />}
        {showHistory && <HistoryPanel onClose={closeHistory} />}
      </div>
      <div className="panel-body result-body">
        {showDetail && <SelectionDetail />}
        {!result || !tpl ? (
          <EmptyState title="분석 결과 대기 중" icon={<LuSparkles />}>
            <p>왼쪽 아래 ‘AI에게 질문하기’를 눌러 질문하면, 추천 형식으로 이곳에 결과가 바로 표시됩니다.</p>
            <ol className="how">
              <li>왼쪽 데이터 관리에서 품목이나 협력사를 고르면 질문 대상으로 쓰입니다</li>
              <li>AI가 데이터를 찾아 계산하고, 알맞은 형식으로 결과를 보여 줍니다</li>
              <li>위의 형식 버튼으로 비교표·시각화·카드·보고서를 바꾸고, 엑셀로 내보낼 수 있습니다</li>
            </ol>
            <div className="empty-actions">
              <button type="button" className="btn btn-primary" onClick={() => dispatch({ type: "chat", open: true })}>
                <AiChatIcon size={18} /> AI 분석 도우미 열기
              </button>
              {historyCount > 0 && (
                <button type="button" className="btn btn-quiet" onClick={() => setShowHistory(true)}>
                  <LuHistory aria-hidden /> 지난 분석 {historyCount}건 보기
                </button>
              )}
            </div>
          </EmptyState>
        ) : (
          <div className="result">
            {stale && (
              <div className="stale" role="status">
                <LuTriangleAlert aria-hidden />
                <span>분석한 뒤 데이터가 바뀌었습니다. 지금 화면은 이전 데이터 기준입니다.</span>
                <button type="button" className="btn btn-small" onClick={() => rerun(result)}>
                  현재 데이터로 다시 분석
                </button>
              </div>
            )}
            <div className="scope">
              {result.scope.map((s) => (
                <span key={s.label} className="scope-item">
                  <b>{s.label}</b> {s.value}
                </span>
              ))}
              {!result.scope.some((x) => x.label === "기준일") && (
                <span className="scope-item">
                  <b>기준일</b> {result.asOf}
                </span>
              )}
            </div>
            {showSrc && (
              <div className="src-panel">
                <p className="src-panel-title">근거 데이터 · 이 결과를 계산한 원천 레코드</p>
                <SourceRecords result={result} />
              </div>
            )}
            {tpl === "report" ? <AnalysisReport result={result} settings={state.settings} ref={reportRef} /> : Renderer ? <Renderer result={result} settings={state.settings} /> : null}
            <p className="result-foot">최종 선정과 조치는 자동 확정되지 않습니다. 이 결과는 담당자 검토를 돕는 의사결정 지원 자료입니다.</p>
          </div>
        )}
      </div>
    </>
  );
}
