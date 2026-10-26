"""로컬 구매관리 스키마에 대한 보수적인 조건 해석.
질문별 정답을 하드코딩하지 않고 DB의 실제 ID/이름/날짜와 대조합니다.
지원하지 않는 항목/모호한 조건은 추측하지 않습니다. LLM 기반 자연어 SQL은 아닙니다.
"""
import calendar
import re
from datetime import date
from .documents import load_records, build_documents

# 규칙 작성 원칙: 평가 질문(calibrate_threshold.py 등)의 단어를 옮겨 적지 않습니다.
# 평가셋에 맞춰 규칙을 만들면 거절률이 구조적으로 100%가 되어 성능을 측정할 수 없습니다.

# 구매관리 관련 키워드입니다. 질문에 하나도 없으면(협력사·부품 이름도 없으면) 범위 밖으로 봅니다.
DOMAIN_TERMS = (r'협력사|공급사|업체|거래처|공급|부품|품목|품번|발주|주문|구매|납품|입고|납기|'
                r'민원|클레임|불량|결함|하자|단가|가격|비용|점수|품질|검사|'
                r'포장|라벨|긁힘|찍힘|스크래치|완충|치수|작동')

# 필터가 지정된 짧은 질문도 같은 조회 항목 규칙으로 해석합니다.
ORDER_FIELDS = r'수량|몇\s*개|납기|예정|발주일|주문일|납품일|상태|cost|비용'

# 구매 업무에는 있지만 현재 schema.sql 컬럼에는 없는 속성입니다.
# 민원 본문 검색에 쓰이는 단어(치수·원인·조치·포장·라벨 등)는 넣지 않습니다.
UNAVAILABLE = {
    '연락처·소재지': r'이메일|e-?mail|전화|연락처|팩스|주소|소재지|공장\s*위치',
    '담당 인력': r'담당자|처리자|담당\s*처리|승인자|책임자',
    '부품 사양': r'재질|무게|중량|회전수|rpm|규격|사양|도면',
    '계약·대금': r'보증|결제|지불|입금|송금|계약\s*조건|운임|운송비|관세|세금|할인|환율',
    '물류': r'운송장|송장\s*번호|배송사|선적',
    '재고': r'재고',
    '리드타임': r'리드\s*타임|lead\s*time',
    '민원 처리 결과': r'해결일|해결\s*날짜|최종\s*해결|처리\s*완료일|처리\s*결과|조치\s*결과',
    '평가 산출근거': r'점수.*(?:산출|평가\s*기간|평가\s*근거)',
    '품질 실적 수량': r'불량률|부적합률|불량\s*수량|검사\s*수량',
}

# 원자재 시세·직종별 인건비 질문을 알아보는 단어입니다. 원자재명·직종명은 DB 값과 대조합니다.
MATERIAL_TERMS = r'원자재|시세'
WAGE_TERMS = r'인건비|임금|급여|노임|직종'

def compact(value):
    return re.sub(r'\s+','',value)

def market_plan(records,docs,text,digest):
    """원자재·직종 하나를 DB 이름과 정확히 대조합니다. 대상이 없거나 여러 개면 추측하지 않습니다."""
    materials=sorted({r['material'] for r in records['material_price']})
    jobs=sorted({r['minor'] for r in records['labor_wage']})
    mat_hits=[m for m in materials if m in compact(text)]
    job_hits=[j for j in jobs if compact(j) in compact(text)]
    wants_mat=bool(mat_hits or re.search(MATERIAL_TERMS,text))
    wants_job=bool(job_hits or re.search(WAGE_TERMS,text))
    if not (wants_mat or wants_job):return None
    if wants_mat and wants_job:
        return decision('clarify','multiple_market_topics','원자재 시세와 인건비 중 하나를 골라 질문해 주세요.')
    kind,hits,names,label=('material_price',mat_hits,materials,'원자재') if wants_mat else ('labor_wage',job_hits,jobs,'직종')
    if not hits:
        return decision('clarify',f'missing_{"material" if wants_mat else "occupation"}',f'조회할 {label}을 지정해 주세요. DB에 있는 {label}: {", ".join(names)}')
    if len(hits)>1:
        return decision('clarify',f'multiple_{"materials" if wants_mat else "occupations"}',f'한 번에 {label} 하나를 지정해 주세요. 질문에서 찾은 {label}: {", ".join(hits)}')
    if re.search(r'최저|가장\s*낮|평균|합계|총합|순위|비교',text):
        return decision('clarify','aggregate_not_supported','비교·집계 질문은 아직 지원하지 않습니다. 원자재·직종 하나의 월별 값을 조회해 주세요.')
    market=('국제' if re.search(r'국제|해외|LME',text,re.I) else '국내' if re.search(r'국내',text) else None) if wants_mat else None
    key='material' if wants_mat else 'occupation'
    candidates=[d for d in docs if d['metadata']['document_type']==kind and d['metadata'][key]==hits[0]
                and (market is None or d['metadata']['market']==market)]
    try:dates=period(text)
    except ValueError:dates=None  # 월별 추이 문서 전체를 근거로 주므로 '최근' 같은 상대 기간은 거절하지 않습니다.
    if dates:
        candidates=[d for d in candidates if any(dates[0][:7]<=m<=dates[1][:7] for m in d['metadata']['months'])]
        if not candidates:
            return decision('reject','no_matching_records',f'근거 부족: 현재 DB에 {hits[0]}의 해당 기간 기록이 없습니다.',date_range=dates)
    conditions={key:hits[0],**({'market':market} if market else {})}
    return decision('structured','validated_conditions','원본 DB에서 조건과 항목을 확인했습니다.',documents=candidates,
                    conditions=conditions,date_range=dates,date_field='month',source_sha256=digest)

def decision(mode, reason, message, **extra):
    return {'mode':mode,'reason':reason,'message':message,**extra}

def period(text):
    """단일 연/월/일 또는 날짜 범위를 inclusive ISO 날짜로 변환합니다."""
    pattern=r'(\d{4})\s*(?:년\s*|[-/.])(\d{1,2})(?:\s*월(?:\s*(\d{1,2})\s*일)?|[-/.](\d{1,2}))'
    spans=[]
    for m in re.finditer(pattern,text):
        year,month=int(m[1]),int(m[2]);day=m[3] or m[4]
        start=date(year,month,int(day) if day else 1)
        end=start if day else date(year,month,calendar.monthrange(year,month)[1])
        spans.append((start.isoformat(),end.isoformat()))
    if not spans:
        for year,month in re.findall(r'\b(\d{4})[-/.](\d{1,2})(?![-/.\d])',text):
            year,month=int(year),int(month)
            spans.append((date(year,month,1).isoformat(),date(year,month,calendar.monthrange(year,month)[1]).isoformat()))
    if not spans:
        years=re.findall(r'(\d{4})\s*년',text)
        spans=[(date(int(y),1,1).isoformat(),date(int(y),12,31).isoformat()) for y in years]
    if len(spans)>1 and not re.search(r'부터|~|까지',text):
        raise ValueError('여러 날짜가 있습니다. 조회할 시작일과 종료일을 명확히 지정해 주세요.')
    if len(spans)>2:raise ValueError('날짜 조건이 복잡합니다. 한 기간씩 질문해 주세요.')
    if spans:
        start,end=spans[0][0],spans[-1][1]
        if start>end:raise ValueError('시작일이 종료일보다 늦습니다.')
        return [start,end]
    if re.search(r'오늘|어제|이번\s*달|지난\s*달|지난달|최근|작년|올해|지난주',text):
        raise ValueError('상대 날짜는 자동 추정하지 않습니다. 조회 연도·월·일을 지정해 주세요.')
    if re.search(r'\d{1,2}\s*월',text):raise ValueError('조회할 연도도 지정해 주세요.')
    return None

def plan(database,question,filters):
    text=question.strip();filters=dict(filters or {})
    records,c_values,digest=load_records(database)
    price=bool(re.search(r'단가|unit_price',text,re.I))
    score=bool(re.search(r'점수|C\s*계산값',text,re.I))
    order_field=bool(re.search(ORDER_FIELDS,text,re.I))
    # '서버 상태'처럼 다른 대상을 명시한 질문을 발주 필터만으로 해석하지 않습니다.
    short_order_question=bool(re.fullmatch(
        rf'(?:{ORDER_FIELDS})(?:\s*(?:은|는|이|가|을|를))?\s*(?:좀\s*)?'
        r'(?:(?:알려|보여)\s*(?:줘|주세요)|얼마(?:야|인가요)?|몇\s*개(?:야|인가요)?)?\s*[?？.!]*',
        text,re.I))
    has_domain_filter=(filters.get('document_type') in ('supplier','part','supplier_part','order','complaint')
                       or any(filters.get(key) is not None for key in
                              ('order_id','delivery_id','complaint_id','supplier_id','part_id')))
    # 금지어 목록 대신, 구매관리 키워드나 DB에 있는 협력사·부품 이름이 있는지로 범위를 판단합니다.
    # 명시적인 필터와 조회 항목이 함께 있으면 질문에 업무 대상 이름을 반복하지 않아도 됩니다.
    names=[r['name'] for r in records['supplier']]+[r['part_name'].replace('(가상)','') for r in records['part']]
    names+=[r['material'] for r in records['material_price']]+[r['minor'] for r in records['labor_wage']]
    in_domain=(re.search(DOMAIN_TERMS,text) or re.search(MATERIAL_TERMS+'|'+WAGE_TERMS,text) or re.search(r'가상\s*[A-Za-z가-힣0-9]+사',text)
               or any(re.sub(r'\s+','',n) in re.sub(r'\s+','',text) for n in names)
               or (has_domain_filter and (price or score or short_order_question)))
    if not in_domain:
        return decision('reject','outside_scope','근거 부족: 현재 구매관리 데이터의 지원 범위 밖 질문입니다.')
    for label,pattern in UNAVAILABLE.items():
        if re.search(pattern,text,re.I):
            return decision('reject','unsupported_field',f'근거 부족: 현재 스키마에서 {label} 항목의 값을 제공할 수 없습니다. 실제 정보가 존재하지 않는다는 의미는 아닙니다.')
    docs=build_documents(records,c_values,database.name,digest)
    routed=market_plan(records,docs,text,digest)
    if routed:return routed
    conditions={k:v for k,v in filters.items() if k!='document_type' and v is not None}
    # 숫자를 문자 포함 검색하지 않고 완전한 정수 ID로 대조합니다.
    for label,key,table in [('발주','order_id','orders'),('민원','complaint_id','complaint'),('납품','delivery_id','delivery')]:
        patterns=[rf'{label}\s*(?:(?:ID|아이디|번호)\s*)?[:#]?\s*(\d+)',rf'(\d+)\s*번\s*{label}']
        values={int(v) for p in patterns for v in re.findall(p,text,re.I)}
        if len(values)>1:return decision('clarify','multiple_ids','한 번에 조회할 ID 하나를 지정해 주세요.')
        if values:
            value=values.pop()
            if key in conditions and conditions[key]!=value:
                return decision('clarify','conflicting_conditions','질문의 ID와 전달된 필터가 다릅니다. 조건을 확인해 주세요.')
            conditions[key]=value
    for key,table in [('order_id','orders'),('complaint_id','complaint'),('delivery_id','delivery'),('supplier_id','supplier'),('part_id','part')]:
        if key in conditions and not any(r[key]==conditions[key] for r in records[table]):
            return decision('reject','unknown_id',f'근거 부족: 현재 DB에 {key}={conditions[key]} 기록이 없습니다.')
    supplier_names=re.findall(r'가상\s*[A-Za-z가-힣0-9]+사',text)
    for name in supplier_names:
        matches=[r for r in records['supplier'] if re.sub(r'\s+','',r['name'])==re.sub(r'\s+','',name)]
        if not matches:return decision('reject','unknown_supplier',f'근거 부족: 현재 DB에 {name} 협력사가 없습니다.')
        sid=matches[0]['supplier_id']
        if 'supplier_id' in conditions and conditions['supplier_id']!=sid:
            return decision('clarify','conflicting_conditions','협력사 조건이 여러 개이거나 필터와 다릅니다. 한 협력사를 지정해 주세요.')
        conditions['supplier_id']=sid
    parts=[r for r in records['part'] if r['part_name'].replace('(가상)','') in text]
    if len(parts)>1:return decision('clarify','multiple_parts','한 번에 조회할 부품 하나를 지정해 주세요.')
    if parts:
        pid=parts[0]['part_id']
        if 'part_id' in conditions and conditions['part_id']!=pid:
            return decision('clarify','conflicting_conditions','질문의 부품과 필터가 다릅니다.')
        conditions['part_id']=pid
    try:dates=period(text)
    except ValueError as error:return decision('clarify','invalid_or_ambiguous_date',str(error))
    complaint=bool(re.search(r'민원|클레임|불량|포장|긁힘|찍힘|스크래치|라벨|완충|작동\s*확인',text))
    order=bool(re.search(r'발주|주문|납품|입고|납기',text) or (has_domain_filter and order_field))
    if re.search(r'최저|가장\s*낮|평균|합계|총합|순위|비교',text):
        return decision('clarify','aggregate_not_supported','비교·집계 질문은 아직 지원하지 않습니다. 협력사·부품·발주를 지정해 개별 값을 조회해 주세요.')
    if price:kind='supplier_part'
    elif score:kind='supplier'
    elif complaint:kind='complaint'
    elif order:kind='order'
    elif filters.get('document_type'):kind=filters['document_type']
    else:return decision('clarify','unrecognized_intent','조회할 항목을 지정해 주세요. 현재는 저장 점수·등록 단가·발주/납품 수량·민원 검색을 지원합니다.')
    if kind=='order' and not (order_field or re.search(r'정보',text)):
        return decision('clarify','unsupported_order_field','발주에서 조회할 수량·비용·날짜·상태 항목을 명확히 지정해 주세요.')
    if score and not re.search(r'[QDTEC]\s*(?:저장\s*)?점수|C\s*계산값',text,re.I):
        return decision('clarify','unsupported_score','조회할 저장 점수 Q/D/T/E 또는 C 계산값을 지정해 주세요.')
    if filters.get('document_type') and filters['document_type']!=kind:
        return decision('clarify','conflicting_document_type','질문의 항목과 document_type 필터가 다릅니다.')
    if price and not {'supplier_id','part_id'}<=conditions.keys():
        unknown=re.search(r'공급하는\s+(.+?)(?:의\s*(?:등록\s*)?단가|\s+(?:등록\s*)?단가)',text)
        if unknown and not parts:
            return decision('reject','unknown_part',f'근거 부족: 현재 DB에 {unknown[1]} 부품이 없습니다.')
        return decision('clarify','missing_price_conditions','등록 단가를 조회할 협력사와 DB에 등록된 부품을 함께 지정해 주세요.')
    if score and 'supplier_id' not in conditions:
        return decision('clarify','missing_supplier','점수를 조회할 협력사를 지정해 주세요.')
    if dates and kind in ['supplier','supplier_part','part']:
        return decision('reject','unsupported_history','근거 부족: 저장 점수·등록 단가의 과거 시점 이력은 현재 DB에 없습니다.')
    if kind=='order' and not conditions:
        return decision('clarify','missing_order_conditions','발주 ID 또는 협력사·부품 조건을 지정해 주세요.')
    delivery_word=bool(re.search(r'납품|입고',text))
    if dates and kind=='complaint' and delivery_word and not re.search(r'납품일|입고일|민원일|접수일',text):
        return decision('clarify','ambiguous_date_field','민원 접수일 기준인지 납품일 기준인지 명시해 주세요.')
    date_field=('complaint_date' if kind=='complaint' else
                'expected_date' if re.search(r'납기|예정',text) else
                'delivery_date' if delivery_word else 'order_date')
    if kind=='complaint' and re.search(r'납품일|입고일',text):date_field='delivery_date'
    candidates=[]
    for doc in docs:
        m=doc['metadata']
        if m['document_type']!=kind:continue
        matched=True
        for key,value in conditions.items():
            if key=='delivery_id' and kind=='order':ok=value in m.get('delivery_ids',[])
            else:ok=m.get(key)==value
            if not ok:matched=False;break
        if not matched:continue
        if dates:
            values=m.get('delivery_dates',[]) if date_field=='delivery_date' and kind=='order' else [m.get(date_field)]
            if not any(v and dates[0]<=v<=dates[1] for v in values):continue
        candidates.append(doc)
    if not candidates:return decision('reject','no_matching_records','근거 부족: 현재 DB에 ID·협력사·부품·날짜 조건을 모두 충족하는 기록이 없습니다.',conditions=conditions,date_range=dates,date_field=date_field)
    structured=kind in ['supplier','supplier_part','order','part'] or ('complaint_id' in conditions)
    if structured and len(candidates)>1:
        return decision('clarify','multiple_records','조건에 맞는 기록이 여러 개입니다. 발주 ID나 더 구체적인 날짜를 지정해 주세요.')
    if structured and dates and date_field=='delivery_date':
        # 한 문서의 누적 납품 수량을 특정 기간 납품량으로 오인하지 않게 보류합니다.
        return decision('clarify','delivery_period_aggregation','기간 내 납품 수량 합산은 아직 지원하지 않습니다. 발주 ID로 누적 납품 수량을 조회해 주세요.')
    return decision('structured' if structured else 'semantic','validated_conditions',
                    '원본 DB에서 조건과 항목을 확인했습니다.',documents=candidates,
                    conditions=conditions,date_range=dates,date_field=date_field,source_sha256=digest)
