"""참고 정답을 쓰지 않는 두 공식 지표만 계산합니다. 기존 3지표 결과와 분리합니다."""
import sys
from pathlib import Path

# Allow both Run Python File and python -m from the project folder.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from project_paths import WORK_DIR, DATABASE, EVALUATIONS_DIR, REPORTS_DIR

import argparse
import asyncio
import hashlib
import importlib.metadata
import json
from evaluations.Ragas_평가준비.evaluate_ragas import (ROOT, OllamaJudge, CachedBGE, MissingEmbeddings, embed,
                            result_value, Faithfulness, AnswerRelevancy,
                            JUDGE, JUDGE_OPTIONS, OLLAMA, call, save)

async def main(stage):
    destination=ROOT.parent/'Ragas_충실도_관련성'/stage
    destination.mkdir(parents=True,exist_ok=True)
    plan=json.loads((ROOT/'평가계획_검토용.json').read_text(encoding='utf8'))
    rows=[]
    for model in plan['generators']:
        for question in plan['rows']:
            if question['track']!='generation':continue
            folder=ROOT/model.replace(':','_') if stage=='baseline' else ROOT.parent/'Ragas_충실도_관련성/tuned_answers'/model.replace(':','_')
            path=folder/(question['id']+'.json')
            rows.append(json.loads(path.read_text(encoding='utf8')))
    embed([row['question'] for row in rows])
    judge=OllamaJudge(); embeddings=CachedBGE()
    if stage=='tuned':
        baseline=json.loads((destination.parent/'baseline/manifest.json').read_text(encoding='utf8'))
        assert baseline['ragas']==importlib.metadata.version('ragas')
        assert baseline['judge']['digest']==judge.identity['digest']
        assert baseline['judge_options']==JUDGE_OPTIONS
        assert baseline['embedding_model']=='BAAI/bge-m3@5617a9f61b028005a4858fdac845db406aefb181'
    faith=Faithfulness(llm=judge)
    relevance=AnswerRelevancy(llm=judge,embeddings=embeddings,strictness=3)
    save(destination/'manifest.json',{'ragas':importlib.metadata.version('ragas'),
        'scope':'기존 개발 30문항 × 3모델의 예비 평가',
        'metrics':['Faithfulness','AnswerRelevancy'],'reference_used':False,
        'judge':judge.identity,'judge_options':JUDGE_OPTIONS,
        'embedding_model':'BAAI/bge-m3@5617a9f61b028005a4858fdac845db406aefb181',
        'cache_note':'동일 요청과 설정의 채점만 재사용. 관련성 질문은 temperature=0/seed=42이므로 중복 가능.'})
    records=[]
    for row in rows:
        folder=destination/row['model'].replace(':','_');folder.mkdir(exist_ok=True)
        target=folder/(row['id']+'.json')
        input_hash=hashlib.sha256(json.dumps({'question':row['question'],'response':row['response'],
            'contexts':row['retrieved_contexts'],'judge':judge.identity['digest'],
            'options':JUDGE_OPTIONS},ensure_ascii=False,sort_keys=True).encode()).hexdigest()
        if target.exists():
            record=json.loads(target.read_text(encoding='utf8'))
            assert record['input_hash']==input_hash,'채점 입력이 바뀌었습니다.'
        else:
            record={'model':row['model'],'id':row['id'],'input_hash':input_hash,'scores':{},'errors':{}}
        records.append((row,record,target))
    # 공식 Faithfulness가 호출할 동일 주장 분해 요청을 먼저 모아 캐시합니다.
    # 지표의 프롬프트/계산식/입력은 유지하고 모델의 프리필 재처리만 줄입니다.
    for row,record,target in records:
        if 'faithfulness' in record['scores']:continue
        save(destination/'progress.json',{'stage':'extracting_claims','model':row['model'],'id':row['id']})
        print(f"{stage} {row['model']} {row['id']} extracting_claims",flush=True)
        try:
            await faith._create_statements(row['question'],row['response'])
        except Exception:
            pass  # 본 지표 계산에서 같은 입력을 다시 시도하고 오류를 기록합니다.
    for name,metric in [('faithfulness',faith),('answer_relevancy',relevance)]:
        for row,record,target in records:
            if name in record['scores']:continue
            kwargs={'user_input':row['question'],'response':row['response']}
            if name=='faithfulness':kwargs['retrieved_contexts']=row['retrieved_contexts']
            save(destination/'progress.json',{'stage':'scoring','model':row['model'],'id':row['id'],'metric':name})
            print(f"{stage} {row['model']} {row['id']} {name}",flush=True)
            try:
                record['scores'][name]=result_value(await metric.ascore(**kwargs))
                record['errors'].pop(name,None)
            except MissingEmbeddings:
                record['errors'][name]='embedding_pending'
            except Exception as error:
                record['errors'][name]=f'{type(error).__name__}: {error}'
            save(target,record)
    call(OLLAMA,'/api/generate',{'model':JUDGE,'keep_alive':0})
    if embeddings.missing:
        embed(sorted(embeddings.missing));embeddings.reload()
    judge.cache_only=True
    for row,record,target in records:
        if record['errors'].get('answer_relevancy')=='embedding_pending':
            try:
                record['scores']['answer_relevancy']=result_value(await relevance.ascore(user_input=row['question'],response=row['response']))
                record['errors'].pop('answer_relevancy')
            except Exception as error:
                record['errors']['answer_relevancy']=f'{type(error).__name__}: {error}'
            save(target,record)
    summary=[]
    for model in plan['generators']:
        items=[record for row,record,target in records if row['model']==model]
        metrics={}
        for name in ['faithfulness','answer_relevancy']:
            values=[record['scores'][name] for record in items if name in record['scores']]
            metrics[name]={'mean':sum(values)/len(values) if values else None,'valid_count':len(values),'total':len(items)}
        summary.append({'model':model,'metrics':metrics,'error_count':sum(bool(record['errors']) for record in items)})
    save(destination/'summary.json',{'stage':stage,'models':summary,'independent_test':False})
    save(destination/'progress.json',{'stage':'complete','answers':len(rows)})
    print(f'{stage}: two-metric scoring complete',flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--stage',choices=['baseline','tuned'],default='baseline')
    asyncio.run(main(parser.parse_args().stage))
