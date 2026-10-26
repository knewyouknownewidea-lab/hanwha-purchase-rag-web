"""scikit-learn 공식 분류 지표로 고정 유사도 필터를 재검증합니다.
기존 60문항/분할/임계값 고정. 실제 API 응답과 저장된 후보 점수를 대조합니다.
"""
import sys
from pathlib import Path

# Allow both Run Python File and python -m from the project folder.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from project_paths import ROOT, DATABASE, VECTOR_DIR, EVALUATIONS_DIR

import hashlib,json,urllib.request
import sklearn
from sklearn.metrics import (confusion_matrix, accuracy_score, balanced_accuracy_score,
                             precision_score, recall_score, f1_score)

def read(p):return json.loads(p.read_text(encoding='utf8'))
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()

def main():
    files=[EVALUATIONS_DIR/'results'/'backend'/'유사도_검증결과.json',ROOT/'backend'/'similarity_policy.json',VECTOR_DIR/'active.json',DATABASE]
    hashes={str(p.relative_to(ROOT)):sha(p) for p in files}
    old,policy,index=map(read,files[:3]);threshold=policy['min_similarity']
    assert threshold==old['threshold'] and index['fingerprint']==old['index_fingerprint']
    rows=[]
    for r in old['rows']:
        req=urllib.request.Request('http://127.0.0.1:8000/search',data=json.dumps({'question':r['question'],'top_k':3}).encode(),headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=180) as response:d=json.load(response)
        assert d['min_similarity']==threshold and d['calibration_matches_index'] and not d['source_changed']
        ids=[h['parent_document_id'] for h in d['results']]
        expected=[h['parent_document_id'] for h in r['candidates'] if h['similarity']>=threshold]
        assert ids==expected,(r['id'],ids,expected)
        accepted=bool(ids)
        assert (d['evidence_status']=='candidates_found')==accepted
        row={**r,'prediction':int(accepted),'returned_document_ids':ids,
             'correct_gold_retained':bool(set(ids)&set(r['gold'])),
             'error':('false_accept' if accepted and not r['answerable'] else
                      'false_reject' if not accepted and r['answerable'] else None)}
        rows.append(row)
    groups={}
    for name in ['calibration','holdout','all']:
        subset=[r for r in rows if name=='all' or r['split']==name]
        truth=[int(r['answerable']) for r in subset];pred=[r['prediction'] for r in subset]
        tn,fp,fn,tp=confusion_matrix(truth,pred,labels=[0,1]).ravel().tolist()
        groups[name]={'n':len(subset),'TN':tn,'FP':fp,'FN':fn,'TP':tp,
            'confusion_matrix':confusion_matrix(truth,pred,labels=[0,1]).tolist(),
            'accuracy':float(accuracy_score(truth,pred)),
            'balanced_accuracy':float(balanced_accuracy_score(truth,pred)),
            'precision':float(precision_score(truth,pred,zero_division=0)),
            'recall':float(recall_score(truth,pred,zero_division=0)),
            'f1':float(f1_score(truth,pred,zero_division=0)),
            'specificity':float(recall_score(truth,pred,pos_label=0,zero_division=0)),
            'positive_wrong_document_only':sum(r['answerable'] and r['prediction'] and not r['correct_gold_retained'] for r in subset),
            'correct_gold_retained':sum(r['correct_gold_retained'] for r in subset)}
        if name!='all':
            before=old[name]
            matches=(fp==before['negative_false_accept'] and fn==before['positive_rejected']
                     and tn==before['negative_rejected'] and groups[name]['correct_gold_retained']==before['correct_evidence_retained'])
            assert matches
            groups[name]['same_counts_as_previous']=matches
    assert hashes=={str(p.relative_to(ROOT)):sha(p) for p in files}
    report={'library':'scikit-learn','version':sklearn.__version__,
            'threshold':threshold,'model':policy['model'],'model_revision':policy['revision'],
            'method':'동일한 60문항을 실제 API에 다시 요청. sklearn 공식 지표로 통과/거절 성능 계산. 임계값 재조정 없음.',
            'positive_label':'1=현재 DB에 정답 근거가 있는 질문',
            'prediction_label':'1=유사도 필터 통과 결과가 하나 이상 있음; 0=근거 부족',
            'confusion_matrix_axes':'행=실제 [정답 없음,정답 있음], 열=예측 [거절,통과]',
            'metrics_scope':'질문 통과/거절의 이진 분류 지표. 정답 문서 검색 여부는 별도 확인. 생성 답변 정확도 아님.',
            'limitations':old['limitations']+['전체60 결과에는 기준 선정용30문항이 포함되므로 독립 성능으로 해석하지 않음.',
                '기준 선정에 사용하지 않은 holdout30문항도 가상 데이터 기반이며 기존 정답 질문은 모델 선택에 이미 사용됨.',
                '라이브러리 교체에 따른 재현성 확인이며 새 업무 평가셋 검증이 아님.'],
            'input_sha256':hashes,'inputs_unchanged':True,'runtime_api_requests':len(rows),'groups':groups,'rows':rows}
    destination=EVALUATIONS_DIR/'sklearn_평가결과';destination.mkdir(parents=True,exist_ok=True)
    (destination/'sklearn_유사도필터_검증결과.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(groups,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
