// 오른쪽 분석 결과창의 질문 주제 화면: 질문에서 찾은 원자재·직종의 추이 그래프, 또는 정보 부족·추가 선택 안내
import { LuMessageSquareText, LuTriangleAlert } from "react-icons/lu";
import { useStore } from "../store/store";
import { RAG_MODE, useAgent } from "../store/agent";
import { topicConditions, type Topic } from "../ai/topic";
import type { PendingClarify } from "../ai/agent";
import { MaterialPrices } from "./subviews/MaterialPrices";
import { LaborWages } from "./subviews/LaborWages";
import { NegotiationPanel } from "./NegotiationPanel";

export function TopicPanel({ topic }: { topic: Topic }) {
  const { state } = useStore();
  const { ask, explore } = useAgent();
  const conds = topicConditions(topic);
  return (
    <div className="topic" data-topic={topic.kind}>
      <div className="topic-head" role="status">
        <p className="topic-q">
          <LuMessageSquareText aria-hidden /> 질문 <q>{topic.question}</q>
        </p>
        {conds.length > 0 && (
          <div className="scope" aria-label="질문에서 찾은 대상과 조건">
            {conds.map((c) => (
              <span key={c.label} className="scope-item" data-cond={c.label}>
                <b>{c.label}</b> {c.value}
              </span>
            ))}
            <span className="scope-item">
              <b>그래프 데이터</b> {state.meta.isSample ? "웹 화면 SAMPLE (구매 DB에 넣은 값과 같은 가상 값)" : state.meta.label}
            </span>
          </div>
        )}
      </div>
      {topic.kind === "material" ? (
        <MaterialPrices key={`${topic.question}-${topic.material}`} focus={topic} />
      ) : topic.kind === "wage" ? (
        <LaborWages key={`${topic.question}-${topic.path.join("›")}`} focus={topic} />
      ) : topic.kind === "negotiation" ? (
        <NegotiationPanel key={`${topic.question}-${topic.supplierId}-${topic.itemCode}`} topic={topic} />
      ) : (
        <div className="topic-unclear" data-unclear>
          <p>
            <LuTriangleAlert aria-hidden /> {topic.message}
          </p>
          <p className="muted small">관련 데이터가 없거나 대상이 정해지지 않아 그래프와 수치를 표시하지 않았습니다.</p>
          {topic.options.length > 0 && (
            <div className="opt-chips" role="group" aria-label="분석 대상 선택">
              {topic.options.map((o) => (
                <button
                  type="button"
                  key={o.label}
                  className="opt-chip"
                  disabled={state.busy}
                  // 원자재·직종 선택은 다시 질문(RAG 답변+화면), 그 밖의 선택은 기존 분석 규칙으로 화면만 바꾼다
                  onClick={() => (o.ask ? ask(o.ask, { mode: RAG_MODE }) : explore(o.label, topic.pending as PendingClarify | undefined))}
                >
                  <span>{o.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
