"""Ragas 공식 metrics.collections로 채점. 로컬 연결 어댑터만 구현합니다."""
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
import math
import os
import subprocess
import time

os.environ['RAGAS_DO_NOT_TRACK'] = 'true'
os.environ['LANGCHAIN_TRACING_V2'] = 'false'
from ragas.llms.base import InstructorBaseRagasLLM
from ragas.embeddings.base import BaseRagasEmbedding
from ragas.metrics.collections import Faithfulness, FactualCorrectness, AnswerRelevancy
from evaluations.Ragas_평가준비.generate_answers import ROOT, call, save

OLLAMA = 'http://127.0.0.1:11434'
JUDGE = 'qwen3:14b'
CACHE = ROOT/'judge_cache'
CACHE.mkdir(exist_ok=True)
JUDGE_OPTIONS = {'temperature':0, 'seed':42, 'num_ctx':8192, 'num_predict':4096, 'num_gpu':20, 'num_thread':4}

class OllamaJudge(InstructorBaseRagasLLM):
    """Ragas의 질문·JSON 스키마를 수정하지 않고 Ollama로 전달합니다."""
    def __init__(self):
        self.model = JUDGE
        self.identity = next(m for m in call(OLLAMA, '/api/tags')['models'] if m['name']==JUDGE)
        self.cache_only = False

    def generate(self, prompt, response_model):
        request = {'model':JUDGE, 'messages':[{'role':'user', 'content':prompt}],
                   'format':response_model.model_json_schema(), 'think':False, 'stream':False,
                   'options':JUDGE_OPTIONS, 'keep_alive':'30m'}
        key = hashlib.sha256(json.dumps({'request':request, 'digest':self.identity['digest']}, sort_keys=True).encode()).hexdigest()
        path = CACHE/(key+'.json')
        if path.exists():
            stored = json.loads(path.read_text(encoding='utf8'))
            return response_model.model_validate(stored['parsed'])
        if self.cache_only:
            raise RuntimeError('Expected cached judge result was not found')
        started = time.monotonic()
        response = call(OLLAMA, '/api/chat', request)
        if response.get('done_reason') == 'length' or response.get('prompt_eval_count',0) >= 7500:
            save(CACHE/(key+'.error.json'), {'request':request, 'response':response})
            raise ValueError('채점 출력 잘림 또는 입력 한도 위험: 점수로 처리하지 않음')
        try:
            parsed = response_model.model_validate_json(response['message']['content'])
        except Exception:
            save(CACHE/(key+'.error.json'), {'request':request, 'response':response})
            raise
        save(path, {'request':request, 'model_digest':self.identity['digest'], 'response':response,
                    'parsed':parsed.model_dump(), 'elapsed_seconds':time.monotonic()-started})
        return parsed

    async def agenerate(self, prompt, response_model):
        return await asyncio.to_thread(self.generate, prompt, response_model)

class MissingEmbeddings(Exception):
    pass

class CachedBGE(BaseRagasEmbedding):
    """메모리 절약을 위해 BGE와 채점 모델을 따로 실행하고 실제 벡터를 캐시합니다."""
    def __init__(self):
        super().__init__()
        self.missing = set()
        self.reload()

    def reload(self):
        path = ROOT/'embedding_cache.json'
        self.vectors = json.loads(path.read_text(encoding='utf8')) if path.exists() else {}

    def embed_text(self, text, **kwargs):
        return self.embed_texts([text])[0]

    def embed_texts(self, texts, **kwargs):
        absent = [text for text in texts if text not in self.vectors]
        if absent:
            self.missing.update(absent)
            raise MissingEmbeddings('별도 BGE 배치 계산 대기')
        return [self.vectors[text] for text in texts]

    async def aembed_text(self, text, **kwargs):
        return self.embed_text(text)

    async def aembed_texts(self, texts, **kwargs):
        return self.embed_texts(texts)

def embed(texts):
    source = ROOT/'embedding_requests.json'
    save(source, list(dict.fromkeys(texts)))
    python = WORK_DIR/'chunking-venv/Scripts/python.exe'
    subprocess.run([str(python), '-X', 'utf8', str(ROOT/'embed_for_evaluation.py'), str(source)], check=True)

def result_value(result):
    value = float(result.value)
    if not math.isfinite(value):
        raise ValueError('Ragas returned a non-finite score')
    return value

async def main():
    plan = json.loads((ROOT/'평가계획_검토용.json').read_text(encoding='utf8'))
    rows = []
    for model in plan['generators']:
        for q in plan['rows']:
            if q['track']=='generation':
                rows.append(json.loads((ROOT/model.replace(':','_')/(q['id']+'.json')).read_text(encoding='utf8')))
    assert len(rows)==90
    # 14B 채점 모델과 BGE를 동시에 메모리에 올리지 않습니다.
    embed([r['question'] for r in rows])
    judge = OllamaJudge()
    emb = CachedBGE()
    faith = Faithfulness(llm=judge)
    factual = FactualCorrectness(llm=judge, mode='f1')
    relevant = AnswerRelevancy(llm=judge, embeddings=emb, strictness=3)
    manifest = {'ragas':importlib.metadata.version('ragas'), 'judge_model':judge.identity,
                'judge_options':JUDGE_OPTIONS, 'generator_options':plan['options_proposed'],
                'execution':'Generators CPU-only; judge fixed GPU 20 layers / CPU remainder after warm-up validation',
                'embeddings':'BAAI/bge-m3@5617a9f61b028005a4858fdac845db406aefb181',
                'metrics_implementation':'ragas.metrics.collections (unmodified)',
                'note':'temperature=0/seed=42 + exact request cache. AnswerRelevancy strictness=3 may reuse identical generated questions.'}
    save(ROOT/'evaluation_manifest.json', manifest)
    # 연결과 명백한 오류 구별을 점검하는 시험이며 채점 모델 자체의 독립 검증은 아닙니다.
    smoke_path = ROOT/'judge_smoke.json'
    if not smoke_path.exists():
        smoke=[]
        for answer in ['납품 수량은 40개입니다.', '납품 수량은 99개입니다.']:
            v = result_value(await faith.ascore(user_input='납품 수량은?', response=answer,
                retrieved_contexts=['발주 1101의 납품 수량은 40개입니다.']))
            smoke.append({'answer':answer,'faithfulness':v})
        save(smoke_path, smoke)
    else:
        smoke=json.loads(smoke_path.read_text(encoding='utf8'))
    if not smoke[0]['faithfulness'] > smoke[1]['faithfulness']:
        raise RuntimeError('채점 모델이 명백한 수량 오류를 구별하지 못해 본 평가를 중단합니다.')
    scored=[]
    for row in rows:
        target = ROOT/row['model'].replace(':','_')/(row['id']+'.scores.json')
        record = json.loads(target.read_text(encoding='utf8')) if target.exists() else {
            'model':row['model'], 'id':row['id'], 'scores':{}, 'errors':{}}
        jobs = {
            'faithfulness':(faith, {'user_input':row['question'], 'response':row['response'], 'retrieved_contexts':row['retrieved_contexts']}),
            'factual_correctness':(factual, {'response':row['response'], 'reference':row['reference']}),
            'answer_relevancy':(relevant, {'user_input':row['question'], 'response':row['response']})}
        for name,(metric,kwargs) in jobs.items():
            if name in record['scores']:
                continue
            save(ROOT/'evaluation_progress.json', {'stage':'scoring', 'model':row['model'], 'id':row['id'], 'metric':name})
            print(f"Scoring {row['model']} {row['id']} {name}", flush=True)
            try:
                record['scores'][name] = result_value(await metric.ascore(**kwargs))
                record['errors'].pop(name, None)
            except MissingEmbeddings:
                record['errors'][name] = 'embedding_pending'
            except Exception as error:
                record['errors'][name] = f'{type(error).__name__}: {error}'
            save(target, record)
        scored.append((row,record,target))
    call(OLLAMA, '/api/generate', {'model':JUDGE,'keep_alive':0})
    if emb.missing:
        embed(sorted(emb.missing))
        emb.reload()
    judge.cache_only=True
    for row,record,target in scored:
        if record['errors'].get('answer_relevancy')=='embedding_pending':
            try:
                record['scores']['answer_relevancy'] = result_value(await relevant.ascore(user_input=row['question'], response=row['response']))
                record['errors'].pop('answer_relevancy')
            except Exception as error:
                record['errors']['answer_relevancy']=f'{type(error).__name__}: {error}'
            save(target,record)
    summary=[]
    for model in plan['generators']:
        records=[record for row,record,target in scored if row['model']==model]
        metrics={}
        for name in ['faithfulness','factual_correctness','answer_relevancy']:
            values=[r['scores'][name] for r in records if name in r['scores']]
            metrics[name]={'mean':sum(values)/len(values) if values else None,'valid_count':len(values),'total':30}
        summary.append({'model':model,'metrics':metrics,'error_count':sum(bool(r['errors']) for r in records)})
    save(ROOT/'ragas_summary.json', {'scope':plan['scope'], 'models':summary})
    save(ROOT/'evaluation_progress.json', {'stage':'complete', 'rows':len(rows)})

if __name__=='__main__':
    asyncio.run(main())
