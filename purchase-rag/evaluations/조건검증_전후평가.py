"""같은 60개 개발 문항으로 라우팅 추가 전후를 비교합니다. 신규 블라인드 시험이 아닙니다."""
import sys
from pathlib import Path

# Allow both Run Python File and python -m from the project folder.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from project_paths import ROOT, DATABASE, VECTOR_DIR, EVALUATIONS_DIR, REPORTS_DIR

import hashlib,html,json,urllib.request
from collections import Counter
from sklearn.metrics import confusion_matrix,accuracy_score,precision_score,recall_score,f1_score

def call(q,filters=None):
    req=urllib.request.Request('http://127.0.0.1:8000/search',data=json.dumps({'question':q,'top_k':3,**(filters or {})}).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=180) as r:return json.load(r)
def metrics(rows):
    y=[int(r['answerable']) for r in rows];p=[int(bool(r['response']['results'])) for r in rows]
    tn,fp,fn,tp=confusion_matrix(y,p,labels=[0,1]).ravel().tolist()
    return {'n':len(rows),'TN':tn,'FP':fp,'FN':fn,'TP':tp,'accuracy':float(accuracy_score(y,p)),
            'precision':float(precision_score(y,p,zero_division=0)),
            'recall':float(recall_score(y,p,zero_division=0)),'f1':float(f1_score(y,p,zero_division=0)),
            'correct_gold_retained':sum(r['correct_gold_retained'] for r in rows),
            'wrong_document_only':sum(r['answerable'] and bool(r['response']['results']) and not r['correct_gold_retained'] for r in rows),
            'routes':dict(Counter(r['response']['retrieval_method'] for r in rows)),
            'clarification_count':sum(r['response']['evidence_status']=='clarification_required' for r in rows)}
def main():
    baseline=json.loads((EVALUATIONS_DIR/'sklearn_평가결과'/'sklearn_유사도필터_검증결과.json').read_text(encoding='utf8'))
    protected=[ROOT/'backend'/'similarity_policy.json',VECTOR_DIR/'active.json',DATABASE]
    before={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
    rows=[]
    for old in baseline['rows']:
        response=call(old['question'])
        assert response['min_similarity']==baseline['threshold']
        ids={h['parent_document_id'] for h in response['results']}
        rows.append({'id':old['id'],'question':old['question'],'answerable':old['answerable'],'gold':old['gold'],
                     'split':old['split'],'previous_prediction':old['prediction'],
                     'correct_gold_retained':bool(ids&set(old['gold'])),'response':response})
    groups={name:metrics([r for r in rows if name=='all' or r['split']==name]) for name in ['calibration','holdout','all']}
    # 추가 회귀 사례는 규칙 구현 확인용이며 독립 평가가 아닙니다.
    probes=[('발주 번호: 1104의 수량 차이',{},'candidates_found','order-1104'),
            ('발주 110의 수량',{},'insufficient_evidence',None),
            ('발주 1104 수량',{'order_id':1101},'clarification_required',None),
            ('가상 B사의 발주 1104 수량',{},'insufficient_evidence',None),
            ('가상 Z사의 베어링 단가',{},'insufficient_evidence',None),
            ('2026년 13월 발주 수량',{},'clarification_required',None),
            ('5월 발주 수량',{},'clarification_required',None),
            ('지난달 가상 A사 발주 수량',{},'clarification_required',None),
            ('2026년 5월 가상 A사의 연료 분사 밸브 발주 수량',{},'candidates_found','order-1004'),
            ('2025년 5월 가상 A사의 연료 분사 밸브 발주 수량',{},'insufficient_evidence',None),
            ('베어링 단가 알려줘',{},'clarification_required',None),
            ('가상 A사의 베어링 재고 수량',{},'insufficient_evidence',None)]
    regression=[]
    for q,f,status,gold in probes:
        response=call(q,f)
        passed=response['evidence_status']==status and (gold is None or any(x['parent_document_id']==gold for x in response['results']))
        assert passed,(q,response)
        regression.append({'question':q,'filters':f,'expected_status':status,'gold':gold,'passed':passed})
    assert before=={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
    report={'scope':'이미 확인한 60개 개발 문항의 개선 전후 회귀 평가. 이전 holdout 명칭은 추적용이며 이제 독립 검증셋이 아님.',
            'threshold_unchanged':baseline['threshold'],'before':baseline['groups'],'after':groups,
            'protected_files_unchanged':True,'rows':rows,'regression_cases':regression,
            'limits':['자연어 해석은 현재 스키마에 맞춘 규칙입니다. 임의의 표현을 모두 이해하지 않습니다.',
                      '정확 조회는 원본 DB에서 처리하므로 이번 개선은 임베딩 모델 자체의 성능 향상이 아닙니다.',
                      '집계·비교, 상대 날짜, 기간 납품량 합산은 아직 지원하지 않고 추가 질문을 요청합니다.',
                      '모르는 항목을 완벽하게 탐지하는 범용 모델이 아닙니다. 새로운 업무 질문으로 별도 검증해야 합니다.']}
    out=EVALUATIONS_DIR/'조건검증_평가결과';out.mkdir(parents=True,exist_ok=True)
    (out/'조건검증_전후결과.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    render(report,out)
    print(json.dumps(groups,ensure_ascii=False,indent=2));print('추가 API 회귀 검사',len(regression),'개 통과')

def render(r,out):
    out=REPORTS_DIR/'조건검증_평가결과'
    out.mkdir(parents=True,exist_ok=True)
    e=lambda s:html.escape(str(s))
    body='''<!doctype html><html lang="ko"><meta charset="utf-8"><title>조건 검증 추가 전후 비교</title><style>body{max-width:1100px;margin:40px auto;padding:0 24px;font:16px/1.7 system-ui;color:#203047}table{border-collapse:collapse;width:100%;margin:16px 0}td,th{border:1px solid #ccd5df;padding:10px;text-align:left}th{background:#edf3f9}pre{white-space:pre-wrap;background:#f3f6f9;padding:12px}details{padding:12px 0}</style>
    <h1>ID·날짜·지원 항목 검증 추가 전후</h1><p>임계값 0.619865 유지 · BGE-M3 유지 · 원본 DB/벡터 인덱스 설정 유지</p>
    <p><b>이미 확인한 60문항의 개발 회귀 평가입니다. 독립된 최종 성능이나 운영 정확도로 해석하지 마세요.</b></p>
    <p>이전: 모든 질문을 벡터 검색 후 점수로 판정. 변경 후: 없는 항목·조건 불일치를 먼저 확인하고, 정확 조회는 원본 DB로 처리합니다. 민원 내용은 검증된 조건 안에서 벡터 검색합니다. 답변 생성은 아직 연결하지 않았습니다.</p>
    <table><tr><th>문항</th><th>잘못 통과 (전→후)</th><th>잘못 거절 (전→후)</th><th>통과·거절 정확도 (전→후)</th><th>정답 근거 유지 (후)</th></tr>'''
    for name,title in [('calibration','이전 기준선정용30'),('holdout','이전 검증용30'),('all','전체60')]:
        a,b=r['before'][name],r['after'][name]
        body+=f"<tr><td>{title}</td><td>{a['FP']} → {b['FP']}</td><td>{a['FN']} → {b['FN']}</td><td>{a['accuracy']:.1%} → {b['accuracy']:.1%}</td><td>{b['correct_gold_retained']}</td></tr>"
    body+='</table><h2>처리 방식</h2><ul><li>정확한 ID·저장 점수·등록 단가: 원본 DB 조회. similarity=null로 표시하며 유사도 필터를 적용하지 않습니다.</li><li>민원 내용: 협력사·부품·날짜 조건에 맞는 문서 ID만 Chroma에서 검색한 뒤 기존 기준 적용.</li><li>없는 ID/협력사/부품/항목/기간 기록: 근거 부족.</li><li>충돌하는 조건·모호한 날짜·미지원 집계: clarification_required로 추가 정보 요청.</li></ul><h2>한계</h2><ul>'
    body+=''.join('<li>'+e(x)+'</li>' for x in r['limits'])+'</ul><h2>60문항별 실제 API 결과</h2>'
    for x in r['rows']:
        d=x['response']
        body+=f"<details><summary>{e(x['id'])} · {e(x['question'])}</summary><p>기존 통과={x['previous_prediction']} / 현재 통과={int(bool(d['results']))} / 경로={e(d['retrieval_method'])}</p><p>{e(d['message'])}</p><p>반환 문서: {e([h['parent_document_id'] for h in d['results']])}</p><p>조건: {e(d.get('validated_conditions'))}, 날짜: {e(d.get('date_range'))}</p></details>"
    body+='<h2>추가 API 회귀 검사</h2><pre>'+e(json.dumps(r['regression_cases'],ensure_ascii=False,indent=2))+'</pre></html>'
    (out/'조건검증_전후보고서.html').write_text(body,encoding='utf8')

if __name__=='__main__':main()
