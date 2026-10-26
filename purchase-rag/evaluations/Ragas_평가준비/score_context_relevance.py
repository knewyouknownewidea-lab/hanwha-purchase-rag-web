"""공통 질문·검색 근거 30개를 Ragas 공식 ContextRelevance로 한 번 평가합니다."""
import sys
from pathlib import Path

# Allow both Run Python File and python -m from the project folder.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from project_paths import WORK_DIR, DATABASE, EVALUATIONS_DIR, REPORTS_DIR

import asyncio
import hashlib
import importlib.metadata
import json
from ragas.metrics.collections import ContextRelevance
from evaluations.Ragas_평가준비.evaluate_ragas import ROOT, OllamaJudge, JUDGE_OPTIONS, result_value, OLLAMA, JUDGE, call, save

class RecordingJudge(OllamaJudge):
    async def agenerate(self,prompt,response_model):
        result=await super().agenerate(prompt,response_model)
        self.ratings.append({'prompt_sha256':hashlib.sha256(prompt.encode()).hexdigest(),'rating':result.rating})
        return result

async def main():
    destination=ROOT.parent/'Ragas_충실도_관련성/context_relevance'
    destination.mkdir(parents=True,exist_ok=True)
    plan=json.loads((ROOT/'평가계획_검토용.json').read_text(encoding='utf8'))
    judge=RecordingJudge()
    baseline=json.loads((destination.parent/'baseline/manifest.json').read_text(encoding='utf8'))
    assert judge.identity['digest']==baseline['judge']['digest'] and JUDGE_OPTIONS==baseline['judge_options']
    assert importlib.metadata.version('ragas')==baseline['ragas']
    metric=ContextRelevance(llm=judge)
    rows=[]
    for question in plan['rows']:
        if question['track']!='generation':continue
        inputs=[json.loads((ROOT/model.replace(':','_')/(question['id']+'.json')).read_text(encoding='utf8')) for model in plan['generators']]
        assert all(x['question']==inputs[0]['question'] and x['retrieved_contexts']==inputs[0]['retrieved_contexts'] for x in inputs)
        data=inputs[0]
        target=destination/(question['id']+'.json')
        key=hashlib.sha256(json.dumps({'question':data['question'],'contexts':data['retrieved_contexts'],
            'judge':judge.identity['digest'],'options':JUDGE_OPTIONS,'ragas':baseline['ragas']},ensure_ascii=False,sort_keys=True).encode()).hexdigest()
        if target.exists():
            row=json.loads(target.read_text(encoding='utf8'));assert row['input_hash']==key
        else:
            save(destination/'progress.json',{'stage':'scoring','id':question['id']})
            print('ContextRelevance '+question['id'],flush=True)
            row={'id':question['id'],'input_hash':key,'score':None,'error':None}
            judge.ratings=[]
            try:
                row['score']=result_value(await metric.ascore(user_input=data['question'],retrieved_contexts=data['retrieved_contexts']))
            except Exception as error:
                row['error']=f'{type(error).__name__}: {error}'
            row['ratings']=judge.ratings
            row['valid_judge_prompts']=len({r['prompt_sha256'] for r in judge.ratings if r['rating'] in [0,1,2]})
            save(target,row)
        rows.append(row)
    scores=[row['score'] for row in rows if row['score'] is not None]
    save(destination/'summary.json',{'metric':'ragas.metrics.collections.ContextRelevance',
        'mean':sum(scores)/len(scores) if scores else None,'valid_count':len(scores),'total':len(rows),
        'degraded_count':sum(row.get('valid_judge_prompts',0)<2 for row in rows),
        'shared_across_models_and_prompts':True,'rows':rows,
        'note':'같은 질문·검색 근거는 P0/P1과 생성 모델에 관계없이 동일. 두 관점의 채점 프롬프트에 같은 Qwen3 14B를 사용함.'})
    save(destination/'progress.json',{'stage':'complete','rows':len(rows)})
    call(OLLAMA,'/api/generate',{'model':JUDGE,'keep_alive':0})

if __name__=='__main__':asyncio.run(main())
