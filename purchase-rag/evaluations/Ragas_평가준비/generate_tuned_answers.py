"""고정한 P1 후보로 기존 30문항×3모델 답변을 생성합니다."""
import sys
from pathlib import Path

# Allow both Run Python File and python -m from the project folder.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from project_paths import WORK_DIR, DATABASE, EVALUATIONS_DIR, REPORTS_DIR

import hashlib
import json
from evaluations.Ragas_평가준비.generate_answers import ROOT, call, save

def main():
    destination=ROOT.parent/'Ragas_충실도_관련성'
    plan=json.loads((destination/'tuning_plan.json').read_text(encoding='utf8'))
    for model in plan['generators']:
        folder=destination/'tuned_answers'/model.replace(':','_');folder.mkdir(parents=True,exist_ok=True)
        identity=next(m for m in call('http://127.0.0.1:11434','/api/tags')['models'] if m['name']==model)
        baseline_metadata=json.loads((ROOT/model.replace(':','_')/'model_metadata.json').read_text(encoding='utf8'))
        assert identity['digest']==baseline_metadata['model']['digest'],'생성 모델이 기존 비교 때와 다릅니다.'
        for row in plan['rows']:
            target=folder/(row['id']+'.json')
            if target.exists():
                existing=json.loads(target.read_text(encoding='utf8'))
                assert existing['prompt_sha256']==hashlib.sha256(row['prompt'].encode()).hexdigest()
                assert existing['model_digest']==identity['digest'] and existing['options']==plan['generator_options']
                assert existing['question']==row['question'] and existing['retrieved_contexts']==row['retrieved_contexts']
                continue
            save(destination/'tuning_progress.json',{'stage':'generating','model':model,'id':row['id']})
            request={'model':model,'messages':[{'role':'user','content':row['prompt']}],
                     'options':plan['generator_options'],'stream':False,'keep_alive':'30m'}
            if model.startswith('qwen3'):request['think']=False
            print(f"P1 {model} {row['id']}",flush=True)
            response=call('http://127.0.0.1:11434','/api/chat',request)
            save(target,{'model':model,'id':row['id'],'question':row['question'],
                         'response':response['message']['content'],
                         'retrieved_contexts':row['retrieved_contexts'],'sources':row['sources'],
                         'model_digest':identity['digest'],'options':plan['generator_options'],
                         'truncated':response.get('done_reason')=='length',
                         'input_budget_warning':response.get('prompt_eval_count',0)>=7168,
                         'prompt_sha256':hashlib.sha256(row['prompt'].encode()).hexdigest(),
                         'raw_response':response})
        call('http://127.0.0.1:11434','/api/generate',{'model':model,'keep_alive':0})
    save(destination/'tuning_progress.json',{'stage':'generation_complete','answers':90})

if __name__=='__main__':main()
