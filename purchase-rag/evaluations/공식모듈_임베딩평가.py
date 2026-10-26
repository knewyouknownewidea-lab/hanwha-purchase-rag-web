"""공식 InformationRetrievalEvaluator로 기존 3모델 실험을 재현합니다.
이 파일은 데이터 연결과 결과 비교만 담당합니다. 평가 지표는 공식 모듈이 계산합니다.
"""
import sys
from pathlib import Path

# Allow both Run Python File and python -m from the project folder.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from project_paths import ROOT, WORK_DIR, DATABASE, CHUNKS_DIR, VECTOR_DIR, EVALUATIONS_DIR, REPORTS_DIR

import os
os.environ['HF_HOME']=str(WORK_DIR/'huggingface')
os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
os.environ['HF_HUB_DISABLE_PROGRESS_BARS']='1'
os.environ['TOKENIZERS_PARALLELISM']='false'
import gc,hashlib,html,importlib.metadata,json,time
import torch
from sentence_transformers import SentenceTransformer
from sentence_transformers.sentence_transformer.evaluation import InformationRetrievalEvaluator
from sentence_transformers.util import cos_sim

def save(path,data):path.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf8')

def main():
    torch.set_num_threads(4);torch.manual_seed(42)
    previous=json.loads((EVALUATIONS_DIR/'results'/'임베딩_검색비교결과.json').read_text(encoding='utf8'))
    input_paths={
        '청크_langchain_800.jsonl': CHUNKS_DIR/'청크_langchain_800.jsonl',
        '검색평가_질문.json': EVALUATIONS_DIR/'datasets'/'검색평가_질문.json',
        '구매관리_테스트.db': DATABASE,
    }
    hashes={name:hashlib.sha256(input_paths[name].read_bytes()).hexdigest() for name in previous['method']['input_hashes']}
    assert hashes==previous['method']['input_hashes'],'기존 평가와 입력 파일이 달라졌습니다.'
    protected=[EVALUATIONS_DIR/'results'/'임베딩_검색비교결과.json',ROOT/'backend'/'similarity_policy.json',VECTOR_DIR/'active.json']
    protected_hashes={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
    chunks=[json.loads(x) for x in (CHUNKS_DIR/'청크_langchain_800.jsonl').read_text(encoding='utf8').splitlines()]
    questions=json.loads((EVALUATIONS_DIR/'datasets'/'검색평가_질문.json').read_text(encoding='utf8'))['questions']
    assert len(chunks)==47 and len(questions)==30
    assert len({c['parent_document_id'] for c in chunks})==47
    corpus={c['parent_document_id']:c['text'] for c in chunks}
    queries={q['id']:q['question'] for q in questions}
    relevant={q['id']:set(q['relevant_document_ids']) for q in questions}
    assert all(golds and golds<=corpus.keys() for golds in relevant.values())
    destination=EVALUATIONS_DIR/'공식평가_결과';destination.mkdir(parents=True,exist_ok=True)
    report={'evaluator':'sentence_transformers.sentence_transformer.evaluation.InformationRetrievalEvaluator',
            'conditions':{'documents':47,'questions':30,'input_sha256':hashes,
                          'device':'cpu','threads':4,'batch_size':8,'similarity':'official cos_sim',
                          'score_threshold':None,'metadata_filters':None,
                          'embedding_source':'공식 평가기가 각 모델로 문서와 질문을 새로 임베딩. 기존 npz 미사용.',
                          'gold':'기존 검색평가_질문.json 그대로. 신규 사용자 승인/독립 평가셋 아님.',
                          'accuracy_mapping':'공식 accuracy@k는 상위 k개에 정답 문서가 하나 이상 있는 질문 비율이며 기존 Hit@k와 동일.',
                          'prompts':'E5 입력에 query:/passage:를 한 번만 추가. 다른 모델 접두어 없음.',
                          'ko_sroberta':'이전과 동일하게 max_seq_length=512. 기본128 설정과 구분.',
                          'ties':'공식 모듈은 점수가 같으면 문서 ID 오름차순. 이전 코드는 입력 문서 순서.'},
            'versions':{p:importlib.metadata.version(p) for p in ['sentence-transformers','transformers','torch','numpy']},
            'previous_versions':previous['method']['versions'],'models':[]}
    for old in previous['models']:
        assert old['status']=='success'
        alias=old['alias'];print('START',alias,flush=True)
        model=SentenceTransformer(old['model'],revision=old['revision'],device='cpu',
                                  token=False,trust_remote_code=False,local_files_only=True)
        model.max_seq_length=old['used_max_tokens']
        prefixed_queries={k:('query: ' if alias=='e5-base' else '')+v for k,v in queries.items()}
        prefixed_corpus={k:('passage: ' if alias=='e5-base' else '')+v for k,v in corpus.items()}
        maximum=max(len(model.tokenizer(t,truncation=False)['input_ids']) for t in list(prefixed_corpus.values())+list(prefixed_queries.values()))
        assert maximum<=model.max_seq_length
        folder=destination/alias;folder.mkdir(exist_ok=True)
        evaluator=InformationRetrievalEvaluator(
            queries=prefixed_queries,corpus=prefixed_corpus,relevant_docs=relevant,
            accuracy_at_k=[1,3,5],precision_recall_at_k=[1,3,5],mrr_at_k=[10],
            ndcg_at_k=[10],map_at_k=[47],batch_size=8,show_progress_bar=False,
            score_functions={'cosine':cos_sim},main_score_function='cosine',name=alias,
            query_prompt='',corpus_prompt='',write_csv=False,write_predictions=True)
        start=time.perf_counter()
        metrics=evaluator(model,output_path=str(folder))
        elapsed=time.perf_counter()-start
        save(folder/'official_metrics.json',metrics)
        selected={f'hit_at_{k}':float(metrics[f'{alias}_cosine_accuracy@{k}']) for k in [1,3,5]}
        selected['mrr_at_10']=float(metrics[f'{alias}_cosine_mrr@10'])
        # 아래는 지표 재계산이 아닌 이전 결과와의 수치/순위 대조입니다.
        differences={k:round(v-old['metrics'][k],10) for k,v in selected.items()}
        predictions=[json.loads(line) for line in next(folder.glob('*.jsonl')).read_text(encoding='utf8').splitlines()]
        assert len(predictions)==30
        rank_changes=[];top5_changes=[]
        old_details={q['id']:q for q in old['details']}
        for row in predictions:
            ids=[x['corpus_id'] for x in row['results']]
            assert len(ids)==47
            gold_rank=min(ids.index(g)+1 for g in relevant[row['query_id']])
            was=old_details[row['query_id']]
            if gold_rank!=was['rank']:rank_changes.append({'question_id':row['query_id'],'before':was['rank'],'after':gold_rank})
            if ids[:5]!=[h['document_id'] for h in was['top5']]:top5_changes.append(row['query_id'])
        result={'model':old['model'],'alias':alias,'revision':old['revision'],
                'max_input_tokens':maximum,'used_max_tokens':model.max_seq_length,
                'official_metrics':metrics,'comparable_metrics':selected,
                'previous_metrics':old['metrics'],'delta_against_rounded_previous':differences,
                'same_at_previous_4_decimal_precision':all(round(v,4)==old['metrics'][k] for k,v in selected.items()),
                'gold_rank_changes':rank_changes,'top5_order_changes':top5_changes,
                'evaluation_seconds_excluding_load':round(elapsed,3)}
        report['models'].append(result);save(destination/'공식평가_비교결과.json',report)
        print('RESULT',alias,json.dumps(selected),'rank changes',len(rank_changes),flush=True)
        del model,evaluator;gc.collect()
    assert protected_hashes=={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
    report['previous_results_and_production_config_unchanged']=True
    save(destination/'공식평가_비교결과.json',report)
    render(report,destination)
    print('DONE',flush=True)

def render(report,destination):
    destination=REPORTS_DIR/'공식평가_결과'
    destination.mkdir(parents=True,exist_ok=True)
    e=lambda x:html.escape(str(x))
    body='''<!doctype html><html lang="ko"><meta charset="utf-8"><title>공식 평가 모듈 재검증</title>
    <style>body{max-width:1100px;margin:40px auto;padding:0 24px;font:16px/1.7 system-ui;color:#203047}table{border-collapse:collapse;width:100%;margin:18px 0}th,td{border:1px solid #cbd5df;padding:10px;text-align:left}th{background:#edf3f9}pre{white-space:pre-wrap;background:#f3f6f9;padding:16px}details{padding:14px 0}</style>
    <h1>공식 InformationRetrievalEvaluator로 재검증</h1>
    <p>동일 문서 47개 · 동일 질문 30개 · 동일 모델 revision · CPU/배치8 · 유사도 필터 미적용</p>
    <p>공식 모듈이 새로 임베딩하고 검색 지표를 계산했습니다. 모델 학습이나 운영 Chroma 재구축은 하지 않았습니다.</p>
    <table><tr><th>모델</th><th>Hit@1 (기존 → 공식)</th><th>Hit@3</th><th>Hit@5</th><th>MRR@10</th><th>정답 순위 변화</th></tr>'''
    for m in report['models']:
        body+=f"<tr><td>{e(m['alias'])}</td>"
        for k in ['hit_at_1','hit_at_3','hit_at_5']:
            body+=f"<td>{m['previous_metrics'][k]:.2%} → {m['comparable_metrics'][k]:.2%}</td>"
        body+=f"<td>{m['previous_metrics']['mrr_at_10']:.4f} → {m['comparable_metrics']['mrr_at_10']:.4f}</td><td>{len(m['gold_rank_changes'])}문항</td></tr>"
    body+='''</table><p>공식 모듈의 accuracy@k는 이 실험에서 기존 Hit@k와 같은 정의입니다. 기존 점수는 소수 넷째 자리까지 저장했으므로 미세한 수치 차이는 반올림 때문인지 확인해야 합니다.</p>
    <h2>이번에 바뀐 것과 바뀌지 않은 것</h2><p>직접 작성했던 Hit/MRR 계산을 공식 평가 모듈로 교체했습니다. 질문과 정답표는 이전 그대로이므로 이 결과는 계산 재현성 확인입니다. 질문의 업무 대표성이나 정답표의 품질을 새롭게 검증한 것은 아닙니다. 새로운 최종 시험이나 공식 인증으로 해석하지 마세요.</p>
    <h2>다른 도구를 별도로 추가하지 않은 이유</h2><ul>
    <li>MTEB: 표준 데이터셋/여러 평가 과제를 확장할 때 유용하지만, 동일한 우리 데이터 검색 평가를 재현하는 이번 작업에는 공식 IR 평가기로 충분합니다.</li>
    <li>NumPy: 필요 없는 라이브러리가 아닙니다. 공식 모듈 내부에서도 사용합니다. 다만 직접 NumPy로 순위와 지표를 구현할 필요가 없어졌습니다.</li>
    <li>pandas: 결과표 정리 도구입니다. 점수 계산에 필수적이지 않아 JSON/HTML로 정리했습니다.</li>
    <li>ir_measures: 실제 Chroma 결과를 채점할 때 유용합니다. 이번 작업은 모델 자체의 전체 문서 검색 비교여서 별도 추가하지 않았습니다.</li>
    <li>scikit-learn: 거절 필터 검증에서 별도로 활용할 수 있습니다. 이번 실험은 정답 있는 질문의 검색 성능만 재현합니다.</li>
    <li>Ragas: 생성 답변의 근거 일치 등을 평가할 때 검토합니다. 이번에는 답변 생성이 없습니다.</li></ul>
    <p>E5 query:/passage: 접두어와 SRoBERTa 최대 길이512도 이전과 동일합니다. 토큰 잘림이 없음을 확인했습니다. 시간은 기존 시험과 측정 구간이 달라 속도 우열의 직접 비교에 사용하지 않습니다.</p>'''
    for m in report['models']:
        body+=f"<details><summary>{e(m['alias'])} 공식 원본 지표와 차이</summary><pre>{e(json.dumps(m,ensure_ascii=False,indent=2))}</pre></details>"
    body+='<p><a href="https://www.sbert.net/docs/package_reference/sentence_transformer/evaluation.html">Sentence Transformers 공식 평가 문서</a></p></html>'
    (destination/'공식평가_비교보고서.html').write_text(body,encoding='utf8')

if __name__=='__main__':main()
