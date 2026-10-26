"""고정된 LangChain 청크와 DB 정답으로 로컬 임베딩 모델 3개를 평가합니다.
API 키 불필요. 최초 실행 시 공개 모델을 다운로드하며 추론은 CPU에서 실행합니다.
"""
import sys
from pathlib import Path

# Allow both Run Python File and python -m from the project folder.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from project_paths import ROOT, WORK_DIR, DATABASE, CHUNKS_DIR, EMBEDDINGS_DIR, EVALUATIONS_DIR

import os
os.environ['HF_HOME']=str(WORK_DIR/'huggingface')
os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
os.environ['HF_HUB_DISABLE_PROGRESS_BARS']='1'
os.environ['HF_HUB_DISABLE_SYMLINKS_WARNING']='1'
os.environ['TOKENIZERS_PARALLELISM']='false'
import gc, hashlib, json, time, statistics, importlib.metadata, traceback
import numpy as np
import torch
from huggingface_hub import HfApi
from sentence_transformers import SentenceTransformer

MODELS=[('e5-base','intfloat/multilingual-e5-base'),
        ('ko-sroberta','jhgan/ko-sroberta-multitask'),('bge-m3','BAAI/bge-m3')]

def save(path,data):
    path.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf8')

def metrics(rows):
    return {'questions':len(rows),
            **{f'hit_at_{k}':round(sum(r['rank']<=k for r in rows)/len(rows),4) for k in (1,3,5)},
            'mrr_at_10':round(sum(1/r['rank'] if r['rank']<=10 else 0 for r in rows)/len(rows),4)}

def main():
    torch.set_num_threads(4)
    torch.manual_seed(42)
    files=[CHUNKS_DIR/'청크_langchain_800.jsonl',EVALUATIONS_DIR/'datasets'/'검색평가_질문.json',DATABASE]
    hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    chunks=[json.loads(x) for x in files[0].read_text(encoding='utf8').splitlines()]
    questions=json.loads(files[1].read_text(encoding='utf8'))['questions']
    assert len({c['parent_document_id'] for c in chunks})==len(chunks)
    vectors_dir=EMBEDDINGS_DIR
    vectors_dir.mkdir(parents=True,exist_ok=True)
    (EVALUATIONS_DIR/'results').mkdir(parents=True,exist_ok=True)
    report={'method':{'chunks':len(chunks),'questions':len(questions),'chunk_size_chars':800,'overlap':0,
                      'search':'L2 정규화한 밀집 벡터의 내적 = 코사인 유사도; 전체 47개 정확 검색',
                      'device':'CPU','torch_threads':4,'batch_size':8,
                      'input_hashes':hashes,'versions':{x:importlib.metadata.version(x) for x in ['sentence-transformers','transformers','torch','numpy']},
                      'scope':'동일 청크/질문으로 임베딩 모델만 비교. 키워드 검색, 메타데이터 필터, 재순위화 미사용.',
                      'metrics':'Hit@k: 정답 문서가 상위 k개에 포함된 질문 비율. MRR@10: 정답 순위 역수 평균(10위 밖은 0).',
                      'limitations':['가상 데이터 47개·직접 작성한 30문항의 소규모 시험. 일반 성능 순위가 아님.',
                                     '답변 생성 정확도, 대용량 벡터 DB 성능, 정답 없는 질문은 평가하지 않음.',
                                     '800자 설정에서는 원본 문서가 분할되지 않음.',
                                     '한국어 SRoBERTa는 입력 누락 방지를 위해 기본 128토큰을 512토큰으로 변경. 학습은 하지 않음.']},
            'models':[]}
    for alias,repo in MODELS:
        print('START',repo,flush=True)
        try:
            revision=HfApi().model_info(repo,token=False).sha
            start=time.perf_counter()
            model=SentenceTransformer(repo,revision=revision,device='cpu',token=False,trust_remote_code=False)
            load_seconds=time.perf_counter()-start
            default_limit=model.max_seq_length
            if alias=='ko-sroberta':
                assert model[0].auto_model.config.max_position_embeddings>=514
                model.max_seq_length=512
            passages=[('passage: ' if alias=='e5-base' else '')+c['text'] for c in chunks]
            queries=[('query: ' if alias=='e5-base' else '')+q['question'] for q in questions]
            lens=[len(model.tokenizer(t,truncation=False)['input_ids']) for t in passages+queries]
            assert max(lens)<=model.max_seq_length,('입력 잘림 방지',max(lens),model.max_seq_length)
            model.encode(['준비 실행'],normalize_embeddings=True,show_progress_bar=False)
            start=time.perf_counter()
            pv=model.encode(passages,batch_size=8,normalize_embeddings=True,show_progress_bar=False)
            passage_seconds=time.perf_counter()-start
            query_times=[]
            for _ in range(3):
                start=time.perf_counter()
                qv=model.encode(queries,batch_size=8,normalize_embeddings=True,show_progress_bar=False)
                query_times.append(time.perf_counter()-start)
            assert np.isfinite(pv).all() and np.isfinite(qv).all()
            assert np.allclose(np.linalg.norm(pv,axis=1),1,atol=1e-5)
            start=time.perf_counter()
            scores=qv@pv.T
            indices=np.argsort(-scores,axis=1,kind='stable')
            search_ms=(time.perf_counter()-start)*1000
            rows=[]
            for i,q in enumerate(questions):
                ranking=indices[i].tolist()
                rank=next(j+1 for j,idx in enumerate(ranking) if chunks[idx]['parent_document_id'] in q['relevant_document_ids'])
                rows.append({'id':q['id'],'category':q['category'],'question':q['question'],
                             'gold':q['relevant_document_ids'],'rank':rank,
                             'top5':[{'document_id':chunks[idx]['parent_document_id'],
                                      'chunk_id':chunks[idx]['id'],'score':round(float(scores[i,idx]),6),
                                      'text':chunks[idx]['text']} for idx in ranking[:5]]})
            np.savez_compressed(vectors_dir/f'{alias}.npz',passage_vectors=pv,query_vectors=qv,
                                chunk_ids=np.array([c['id'] for c in chunks]),question_ids=np.array([q['id'] for q in questions]))
            row={'alias':alias,'model':repo,'revision':revision,'status':'success','dimension':pv.shape[1],
                 'default_max_tokens':default_limit,'used_max_tokens':model.max_seq_length,'max_input_tokens':max(lens),
                 'truncated_inputs':0,'load_and_download_seconds':round(load_seconds,3),
                 'passage_embedding_seconds':round(passage_seconds,3),
                 'query_batch_seconds_median':round(statistics.median(query_times),3),
                 'search_30_questions_ms':round(search_ms,3),'metrics':metrics(rows),
                 'by_category':{cat:metrics([r for r in rows if r['category']==cat]) for cat in dict.fromkeys(r['category'] for r in rows)},
                 'details':rows}
            report['models'].append(row)
            save(EVALUATIONS_DIR/'results'/'임베딩_검색비교결과.json',report)
            print('RESULT',repo,json.dumps(row['metrics']),flush=True)
            del model,pv,qv
            gc.collect()
        except Exception as e:
            report['models'].append({'alias':alias,'model':repo,'status':'failed','error':str(e)})
            save(EVALUATIONS_DIR/'results'/'임베딩_검색비교결과.json',report)
            traceback.print_exc()
    assert hashes=={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    report['inputs_unchanged']=True
    save(EVALUATIONS_DIR/'results'/'임베딩_검색비교결과.json',report)
    print('FINISHED',flush=True)

if __name__=='__main__':
    main()
