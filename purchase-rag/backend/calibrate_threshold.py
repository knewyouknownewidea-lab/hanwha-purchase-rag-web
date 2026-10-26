"""실행 중인 필터 적용 전 API로 고정 평가셋을 검색하고 임계값을 선택합니다.
원본 질문/검색 결과를 저장하므로 적용 후에도 동일 데이터로 재계산할 수 있습니다.
"""
import json
import urllib.request
from pathlib import Path

from project_paths import EVALUATIONS_DIR, VECTOR_DIR

HERE=Path(__file__).resolve().parent
DATASETS=EVALUATIONS_DIR/'datasets'
RESULTS=EVALUATIONS_DIR/'results'/'backend'

NEGATIVES=[
 ('범위 밖','내일 서울 날씨는 어때?','날씨 데이터 없음'),
 ('범위 밖','김치찌개 만드는 방법을 알려줘.','요리 정보 없음'),
 ('범위 밖','대한민국의 수도는 어디야?','국가 정보 없음'),
 ('범위 밖','파이썬 리스트 정렬 코드를 작성해줘.','프로그래밍 자료 없음'),
 ('범위 밖','이번 주 축구 경기 결과를 알려줘.','스포츠 자료 없음'),
 ('범위 밖','제주도 여행 숙소 추천해줘.','여행 자료 없음'),
 ('범위 밖','미분과 적분의 차이는 뭐야?','수학 자료 없음'),
 ('범위 밖','노트북 배터리를 오래 쓰는 방법은?','기기 사용 자료 없음'),
 ('범위 밖','오늘 달러 환율은 얼마야?','환율 데이터 없음'),
 ('범위 밖','회사 휴가 신청 절차를 알려줘.','인사 규정 없음'),
 ('없는 속성','가상 A사 담당자의 이메일 주소를 알려줘.','supplier에 이메일 컬럼 없음'),
 ('없는 속성','가상 B사의 담당자 전화번호는?','supplier에 전화번호 컬럼 없음'),
 ('없는 속성','가상 C사의 공장 주소는 어디야?','supplier에 주소 컬럼 없음'),
 ('없는 속성','실린더 라이너의 재질과 무게는?','part에 재질/무게 없음'),
 ('없는 속성','베어링의 허용 회전수는 얼마야?','part에 허용 회전수 없음'),
 ('없는 속성','연료 분사 밸브의 제조사 보증 기간은?','보증 기간 없음'),
 ('없는 속성','1101번 발주의 결제 완료일은 언제야?','orders에 결제 완료일 없음'),
 ('없는 속성','1102번 발주의 운송장 번호를 알려줘.','운송장 번호 없음'),
 ('없는 속성','3001번 민원의 최종 해결일은 언제야?','complaint에 해결일 없음'),
 ('없는 속성','3008번 민원의 담당 처리자는 누구야?','complaint에 처리자 없음'),
 ('없는 기록','9999번 발주의 납품 수량은 얼마야?','orders에 order_id=9999 없음'),
 ('없는 기록','8888번 발주의 납기 예정일은 언제야?','orders에 order_id=8888 없음'),
 ('없는 기록','가상 D사의 등록된 Q 점수는 얼마야?','supplier에 가상 D사 없음'),
 ('없는 기록','가상 E사의 베어링 등록 단가를 알려줘.','supplier에 가상 E사 없음'),
 ('없는 기록','2027년 1월 가상 A사의 실린더 라이너 발주 수량은?','2027년 발주 없음'),
 ('없는 기록','2025년 12월 가상 B사의 베어링 납품 수량은?','2025년 납품 없음'),
 ('없는 기록','9999번 민원에 적힌 불량 유형은?','complaint에 complaint_id=9999 없음'),
 ('없는 기록','8888번 민원의 접수 날짜는 언제야?','complaint에 complaint_id=8888 없음'),
 ('없는 기록','가상 A사가 공급하는 터보차저의 등록 단가는?','part에 터보차저 없음'),
 ('없는 기록','가상 B사가 공급하는 프로펠러의 단가는?','part에 프로펠러 없음')]

def evaluate(rows, threshold):
    positives=[r for r in rows if r['answerable']]
    negatives=[r for r in rows if not r['answerable']]
    def kept(r):return [h for h in r['candidates'] if h['similarity']>=threshold]
    correct=sum(any(h['parent_document_id'] in r['gold'] for h in kept(r)) for r in positives)
    rejected=sum(not kept(r) for r in negatives)
    return {'positive_questions':len(positives),'correct_evidence_retained':correct,
            'positive_rejected':sum(not kept(r) for r in positives),
            'positive_wrong_only':sum(bool(kept(r)) and not any(h['parent_document_id'] in r['gold'] for h in kept(r)) for r in positives),
            'negative_questions':len(negatives),'negative_rejected':rejected,
            'negative_false_accept':len(negatives)-rejected,
            'balanced_success':round((correct/len(positives)+rejected/len(negatives))/2,6)}

def main():
    source=json.loads((DATASETS/'검색평가_질문.json').read_text(encoding='utf8'))['questions']
    rows=[]
    for i,q in enumerate(source):
        rows.append({'id':q['id'],'question':q['question'],'category':q['category'],
                     'answerable':True,'gold':q['relevant_document_ids'],
                     'split':'calibration' if i%2==0 else 'holdout'})
    for i,(category,q,reason) in enumerate(NEGATIVES):
        rows.append({'id':f'N{i+1:02}','question':q,'category':category,'answerable':False,
                     'gold':[],'reason':reason,'split':'calibration' if i%2==0 else 'holdout'})
    DATASETS.mkdir(parents=True,exist_ok=True)
    RESULTS.mkdir(parents=True,exist_ok=True)
    dataset=DATASETS/'유사도_평가셋.json'
    dataset.write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf8')
    # 질문 분할을 먼저 고정한 다음 검색 결과를 수집합니다.
    cached_path=RESULTS/'유사도_검증결과.json'
    cached=json.loads(cached_path.read_text(encoding='utf8')) if cached_path.exists() else None
    for row in rows:
        if cached:
            current=json.loads((VECTOR_DIR/'active.json').read_text(encoding='utf8'))
            if cached['index_fingerprint']!=current['fingerprint']:
                raise RuntimeError('인덱스가 변경되었습니다. 새로운 필터 적용 전 평가 데이터를 수집해야 합니다.')
            previous=next(r for r in cached['rows'] if r['id']==row['id'])
            assert previous['question']==row['question']
            row['candidates']=previous['candidates']
            continue
        req=urllib.request.Request('http://127.0.0.1:8000/search',data=json.dumps({'question':row['question'],'top_k':3}).encode(),headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=180) as response:result=json.load(response)
        if 'min_similarity' in result:
            raise RuntimeError('필터 적용 결과로 임계값을 다시 학습할 수 없습니다. 저장된 필터 적용 전 결과를 사용하세요.')
        row['candidates']=[{'parent_document_id':h['parent_document_id'],'similarity':h['similarity']} for h in result['results']]
    calibration=[r for r in rows if r['split']=='calibration']
    holdout=[r for r in rows if r['split']=='holdout']
    scores=sorted({h['similarity'] for r in calibration for h in r['candidates']})
    thresholds=[-1.0]+[(a+b)/2 for a,b in zip(scores,scores[1:])]+[1.0]
    trials=[{'threshold':t,**evaluate(calibration,t)} for t in thresholds]
    # 정답 근거 유지율과 정답 없는 질문 거절률을 같은 비중으로 평가합니다.
    chosen=max(trials,key=lambda x:(x['balanced_success'],-x['negative_false_accept'],x['threshold']))
    threshold=chosen['threshold']
    index=json.loads((VECTOR_DIR/'active.json').read_text(encoding='utf8'))
    report={'method':'30 positive + 30 negative; alternating split fixed before scoring; top_k=3, no metadata filters',
            'selection':'maximize mean(correct gold retained rate, unanswerable rejection rate) on calibration only; tie: fewer false accepts then higher threshold',
            'threshold':threshold,'calibration':evaluate(calibration,threshold),'holdout':evaluate(holdout,threshold),
            'baseline_holdout':evaluate(holdout,-1),'index_fingerprint':index['fingerprint'],
            'limitations':['소규모 합성 질문 평가. 기존 정답 질문은 모델 선택에도 사용되었으므로 완전한 신규 벤치마크가 아님.',
                           '독립 문서 단위 분할이 아닌 질문 단위 분할. 실제 업무 질문으로 추가 검증 필요.',
                           '유사도는 답변 가능성이나 사실 정확성을 보장하지 않음. 없는 속성/ID도 비슷한 문서를 찾을 수 있음.'],
            'rows':rows,'trials':trials}
    cached_path.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    policy={'min_similarity':threshold,'model':index['pipeline']['model'],'revision':index['pipeline']['revision'],
            'metric':'cosine','calibrated_index_fingerprint':index['fingerprint'],'calibrated_top_k':3}
    (HERE/'similarity_policy.json').write_text(json.dumps(policy,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps({k:v for k,v in report.items() if k not in ['rows','trials']},ensure_ascii=False,indent=2))

if __name__=='__main__':main()
