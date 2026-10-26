// 첫 사용 안내 (3단계) — 처음 로그인하면 한 번 뜨고, 사용자 메뉴의 '사용 안내 다시 보기'로 다시 볼 수 있다
import { useEffect, useRef, useState } from "react";
import { LuArrowLeft, LuArrowRight, LuX } from "react-icons/lu";
import { ONBOARDED, useStore } from "../store/store";
import { userKey, writeStore } from "../platform/storage";
import { trapTab } from "./focus";

const STEPS = [
  {
    title: "1. 데이터 확인하기",
    body: [
      "지금 보이는 업체·수치는 모두 SAMPLE(시연용 가상) 데이터입니다. 실제 데이터는 오른쪽 위 ‘데이터 불러오기’로 올리고, ‘샘플 데이터로 되돌리기’로 언제든 되돌립니다.",
      "데이터 관리 위의 채점 카드에서 협력사 평가 등급을 보고, 오른쪽 위 ‘근거’로 계산 근거를 엽니다(처리 단계는 그 아래 작은 아이콘). 종 모양 알림은 7일 안에 대금 결제일이 다가온 건입니다.",
      "데이터 관리의 4개 탭에서 빠른 필터·상세 필터(부품 분류 포함)로 찾고, 행을 누르면 오른쪽 분석 결과창에 상세가 열립니다(결과창 위 아이콘으로 접고 펼침). ☆를 누르면 관심 협력사·부품으로 고정됩니다.",
    ],
  },
  {
    title: "2. AI에게 질문하기",
    body: [
      "왼쪽 아래 ‘AI에게 질문하기’를 누르면 대화창이 열립니다. 입력창 위의 추천 질문을 눌러도 됩니다.",
      "데이터 관리에서 고른 품목·협력사가 질문 대상으로 쓰입니다. 계산은 데이터로 하고, 업체 선정은 자동으로 확정하지 않습니다.",
    ],
  },
  {
    title: "3. 결과 보기·내보내기",
    body: [
      "분석 결과창 위의 형식 버튼으로 비교표·데이터 시각화·종합 평가 카드·분석 보고서를 바꿔 봅니다. (태블릿·휴대폰은 ‘분석 결과’ 탭)",
      "보기 설정에서 열·정렬·프리셋을 바꾸고, 내보내기로 엑셀(.xlsx) 파일을 받습니다. 지난 결과는 ‘분석 이력’에서 이름으로 찾습니다.",
      "이 안내는 오른쪽 위 사용자 메뉴의 ‘사용 안내 다시 보기’로 다시 볼 수 있습니다.",
    ],
  },
];

export function Onboarding() {
  const { state, dispatch } = useStore();
  const [i, setI] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.onboarding) {
      setI(0);
      setTimeout(() => ref.current?.focus(), 0);
    }
  }, [state.onboarding]);
  if (!state.onboarding) return null;
  const done = () => {
    writeStore(userKey(state.user.id, ONBOARDED), true);
    dispatch({ type: "onboarding", open: false });
  };
  const s = STEPS[i];
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && done()}>
      <div
        className="modal onboarding"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ob-title"
        tabIndex={-1}
        ref={ref}
        onKeyDown={(e) => {
          if (e.key === "Escape") done();
          if (e.key === "ArrowRight" && i < STEPS.length - 1) setI(i + 1);
          if (e.key === "ArrowLeft" && i > 0) setI(i - 1);
          trapTab(e, ref.current);
        }}
      >
        <div className="modal-head">
          <div>
            <p className="pop-eyebrow">처음 오셨나요? 30초 사용 안내</p>
            <h2 id="ob-title">{s.title}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={done} aria-label="안내 닫기">
            <LuX aria-hidden />
          </button>
        </div>
        <div className="modal-body">
          <ul className="ob-list">
            {s.body.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <div className="ob-dots" aria-label={`${STEPS.length}단계 중 ${i + 1}단계`}>
            {STEPS.map((_, k) => (
              <span key={k} className={k === i ? "is-on" : ""} />
            ))}
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-quiet" onClick={done} id="ob-skip">
            건너뛰기
          </button>
          <span className="spacer" />
          {i > 0 && (
            <button type="button" className="btn btn-quiet" onClick={() => setI(i - 1)}>
              <LuArrowLeft aria-hidden /> 이전
            </button>
          )}
          {i < STEPS.length - 1 ? (
            <button type="button" className="btn btn-primary" onClick={() => setI(i + 1)} id="ob-next">
              다음 <LuArrowRight aria-hidden />
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={done} id="ob-done">
              시작하기
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
