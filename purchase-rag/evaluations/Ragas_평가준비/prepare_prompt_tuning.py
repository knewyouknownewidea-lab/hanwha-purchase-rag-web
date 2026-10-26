"""관측한 오류를 대상으로 프롬프트 후보 한 개를 사전에 고정합니다."""
import sys
from pathlib import Path

# Allow both Run Python File and python -m from the project folder.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from project_paths import WORK_DIR, DATABASE, EVALUATIONS_DIR, REPORTS_DIR

import hashlib
import json
from evaluations.Ragas_평가준비.generate_answers import ROOT, save

from backend.prompting import PROMPT_TEMPLATE

ADDITIONAL_RULES = '''[추가 답변 규칙]
6. 질문의 대상과 요청한 항목이 드러나는 완전한 문장으로 1~3문장 이내에 답하세요. 숫자나 ID만 나열하지 마세요.
7. 민원을 찾는 질문에는 해당 민원 ID와 기록된 민원 내용을 함께 답하세요. 원인 확인·조치 의견을 요청한 기록은 실제 원인 확정·조치 완료와 구분하세요. 표현이 달라도 의미가 같은 관련 기록이 있으면 그 기록을 사용하세요.
8. 날짜는 납품일·민원일 등 기록된 의미 그대로 전달하세요. 기록에 없는 문제 발생일, 인과관계, 통화나 측정 단위를 추정하지 마세요.
9. 각 사실 문장에 이를 뒷받침하는 출처 번호를 [E1] 형태로 붙이세요. 관련 기록이 존재하면 확인된 내용을 답하고, 요청한 세부 정보가 기록에 없다는 이유로 관련 기록 자체가 없다고 답하지 마세요.'''

TUNED_TEMPLATE = PROMPT_TEMPLATE.replace('\n[참고 문서]\n','\n'+ADDITIONAL_RULES+'\n\n[참고 문서]\n')

def main():
    destination=ROOT.parent/'Ragas_충실도_관련성'
    destination.mkdir(exist_ok=True)
    plan=json.loads((ROOT/'평가계획_검토용.json').read_text(encoding='utf8'))
    rows=[]
    for row in plan['rows']:
        if row['track']!='generation':continue
        baseline=json.loads((ROOT/plan['generators'][0].replace(':','_')/(row['id']+'.json')).read_text(encoding='utf8'))
        contexts=baseline['retrieved_contexts'];sources=baseline['sources']
        context='\n\n'.join(f"[{source['evidence_id']}]\n{text}\n출처: {', '.join(source['source']['source_refs'])}"
                             for text,source in zip(contexts,sources))
        p0=PROMPT_TEMPLATE.format(context=context,question=row['question'])
        assert p0==row['prompt'],'기존 프롬프트와 재구성 결과가 다릅니다.'
        p1=TUNED_TEMPLATE.format(context=context,question=row['question'])
        assert len(p1.encode('utf8'))<=6144,'보완 프롬프트가 서비스 입력 한도를 초과합니다.'
        rows.append({**row,'baseline_prompt':p0,'prompt':p1})
    proposal={'candidate':'P1','status':'evaluation_only','production_prompt_modified':False,
              'tuning_method':'프롬프트 규칙 보완. 모델 재학습/가중치 변경 없음.',
              'generators':plan['generators'],'generator_options':{**plan['options_proposed'],'num_gpu':0,'num_thread':4},
              'base_template_sha256':hashlib.sha256(PROMPT_TEMPLATE.encode()).hexdigest(),
              'tuned_template_sha256':hashlib.sha256(TUNED_TEMPLATE.encode()).hexdigest(),
              'rules':ADDITIONAL_RULES,
              'scope':'관측한 기존 개발 오류에 대한 30문항 재검사. 독립 holdout이 아님.',
              'selection_rule':'후보는 한 개로 고정. 두 지표, 유효 수, 불필요한 거절·출처·단위·날짜 오류를 함께 비교. 자동으로 운영 적용하지 않음.',
              'rows':rows}
    save(destination/'tuning_plan.json',proposal)
    (destination/'튜닝_추가규칙.txt').write_text(ADDITIONAL_RULES,encoding='utf8')
    (destination/'튜닝_프롬프트_예시.txt').write_text(rows[0]['prompt'],encoding='utf8')
    print('One candidate frozen; 30 contexts/questions unchanged; production prompt unchanged.')

if __name__=='__main__':main()
