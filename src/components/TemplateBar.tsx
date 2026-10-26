// 분석 결과창 상단: 결과 형식 4종을 항상 고정 표시
import type { AnalysisResult, TemplateId } from "../lib/analysisTypes";
import { TEMPLATES, TEMPLATE_ORDER, templateContent } from "../templates/registry";

export function TemplateBar({ result, active, onChoose }: { result: AnalysisResult | null; active: TemplateId | null; onChoose: (t: TemplateId) => void }) {
  return (
    <div className="tpl-bar" role="tablist" aria-label="결과 형식">
      {TEMPLATE_ORDER.map((id) => {
        const def = TEMPLATES[id];
        const Icon = def.icon;
        const available = !!result && result.templates.includes(id);
        const isActive = available && active === id;
        const isRec = available && result!.recommended === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`tpl-btn ${isActive ? "is-active" : ""}`}
            disabled={!available}
            onClick={() => onChoose(id)}
            data-template={id}
            title={result ? templateContent(id, result.kind) : "챗봇에 질문하면 선택할 수 있습니다"}
          >
            <span className="tpl-btn-top">
              <Icon aria-hidden className="tpl-btn-icon" />
              <span className="tpl-btn-label">{def.label}</span>
              {isRec && <span className="tpl-rec">추천</span>}
            </span>
            <span className="tpl-btn-sub">{result ? templateContent(id, result.kind) : def.description}</span>
          </button>
        );
      })}
    </div>
  );
}
