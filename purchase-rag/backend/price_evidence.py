"""현재 웹 가격 비교를 재검산하고, 별도 조건 문서만 일반 RAG로 설명합니다."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import re
import threading
from pathlib import Path
from urllib.parse import urlsplit

import numpy as np

MAX_PRICE_BYTES = 256 * 1024
SAFE_INTEGER = 9007199254740991
KEYS = ('itemCode', 'drawing', 'specification', 'material', 'processing', 'inspection',
        'quantity', 'unit', 'currency', 'priceDate', 'taxTerms', 'transportTerms', 'deliveryTerms')
LABELS = ('품목', '도면', '규격', '재질', '가공 요구사항', '검사 조건', '구매 수량',
          '단위', '통화', '가격 기준일', '세금 조건', '운송비 조건', '납품 조건')
STATUSES = ('comparable', 'needs_confirmation', 'excluded')
STATUS_LABELS = dict(zip(STATUSES, ('비교 가능', '조건 확인 필요', '비교 제외')))
ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:\-]{0,127}')


class PriceInputError(ValueError):
    """외부 입력의 세부 내용은 오류 응답에 넣지 않습니다."""


def require(condition):
    if not condition:
        raise PriceInputError('가격 비교 질문·조건·계산 결과의 형식이나 범위를 확인해 주세요.')


def fields(value, required, optional=()):
    require(isinstance(value, dict) and set(required) <= set(value) <= set(required) | set(optional))


def string(value, limit=2000, empty=False):
    require(isinstance(value, str) and len(value) <= limit and (empty or bool(value.strip())) and not any(ord(c) < 32 and c not in '\t\n\r' for c in value))


def identifier(value):
    require(isinstance(value, str) and bool(ID.fullmatch(value)))


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def positive(value):
    return number(value) and 0 < value <= SAFE_INTEGER


def date(value):
    try:
        return isinstance(value, str) and bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}', value)) and dt.date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def clean(value):
    return ' '.join(value.split()) if isinstance(value, str) else value


def missing(value):
    return value is None or isinstance(value, str) and not value.strip()


def conditions_shape(value):
    fields(value, (), KEYS)
    for key, item in value.items():
        if item is None:
            continue
        if key == 'quantity':
            require(number(item))
        else:
            string(item, empty=True)


def source_shape(value):
    fields(value, ('documentId', 'title', 'date'), ('page', 'url'))
    for key, item in value.items():
        string(item, 2000, empty=True)


def indicator_time(value):
    if date(value):
        return True
    if not isinstance(value, str) or len(value) > 64 or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})', value):
        return False
    try:
        return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).tzinfo is not None
    except ValueError:
        return False


def indicators_shape(indicators):
    require(isinstance(indicators, list) and len(indicators) <= 20)
    ids = set()
    for item in indicators:
        fields(item, ('id', 'kind', 'label', 'status', 'value', 'unit', 'currency', 'source', 'sourceUrl', 'observedAt', 'fetchedAt', 'message', 'isSample'))
        identifier(item['id']); require(item['id'] not in ids); ids.add(item['id'])
        require(item['kind'] in ('fx', 'material', 'index'))
        require(item['status'] in ('connected', 'unavailable', 'not_configured', 'example', 'loading'))
        require(type(item['isSample']) is bool)
        for key, limit in (('label', 200), ('unit', 80), ('source', 300), ('message', 1000)):
            string(item[key], limit, empty=key == 'unit')
        require(item['currency'] is None or isinstance(item['currency'], str) and bool(re.fullmatch(r'[A-Z]{3}', item['currency'])))
        require(item['value'] is None or number(item['value']) and abs(item['value']) <= SAFE_INTEGER)
        if item['status'] in ('connected', 'example'):
            require(positive(item['value']))
        else:
            require(item['value'] is None)
        if item['status'] == 'example':
            require(item['isSample'])
        for key in ('observedAt', 'fetchedAt'):
            require(item[key] is None or indicator_time(item[key]))
        if item['sourceUrl'] is not None:
            string(item['sourceUrl'], 2048)
            require(not any(char.isspace() for char in item['sourceUrl']))
            try:
                url = urlsplit(item['sourceUrl'])
                require(url.scheme == 'https' and bool(url.hostname) and not url.username and not url.password and not url.fragment)
                url.port  # 잘못된 포트 표기는 공개 참고 링크에서도 허용하지 않습니다.
            except ValueError:
                require(False)
        if item['status'] == 'connected':
            require(all(item[key] is not None for key in ('sourceUrl', 'observedAt', 'fetchedAt')))


def indicator_lines(indicators):
    lines = ['외부 API 참고 정보: 질문을 전송할 때 화면에서 공유한 스냅샷 기준입니다. 전송 후 조회가 완료되거나 상태가 바뀌면 새 질문에 반영됩니다. 이 답변에서 API를 다시 조회하지 않았습니다.']
    status = dict(connected='연결됨', unavailable='조회 실패', not_configured='미연결', example='예시', loading='조회 중')
    for item in indicators:
        value = f"{item['value']:,} {item['unit']}" if item['value'] is not None else '조회값 없음'
        sample = ' · SAMPLE 가상 지표' if item['isSample'] else ''
        lines.append(f"{item['label']}: {status[item['status']]}{sample} · 값 {value} · 출처 {item['source']}" +
                     (f" ({item['sourceUrl']})" if item['sourceUrl'] else '') +
                     f" · 관측 {item['observedAt'] or '없음'} · 조회 {item['fetchedAt'] or '없음'}. {item['message']}")
    if not indicators:
        lines.append('이 질문의 공유 스냅샷에는 외부 API 참고 정보가 없습니다.')
    lines.append('환율·원자재·가격지수는 별도 참고 지표이며 완성부품 외부 견적 중앙값과 다릅니다. 가격 비교 기준일과 관측일도 별개입니다. 원가 구성·기간·문서 근거 없이 원자재 변동을 완성부품 가격 차이의 원인으로 단정하거나 차이율에 보정하지 않습니다.')
    return lines


def record_shape(value, external):
    required = ('id', 'itemCode', 'supplierName' if external else 'supplierId', 'unitPrice', 'conditions', 'source', 'isSample', 'kind')
    fields(value, required, () if external else ('linkedContractId',))
    for key in ('id', 'itemCode', 'supplierName' if external else 'supplierId'):
        string(value[key], 128)
    identifier(value['id'])
    identifier(value['itemCode'])
    if not external:
        identifier(value['supplierId'])
    if 'linkedContractId' in value:
        identifier(value['linkedContractId'])
    require(value['unitPrice'] is None or number(value['unitPrice']))
    require(type(value['isSample']) is bool)
    require(value['kind'] == 'external_finished_quote' if external else value['kind'] in ('contract', 'supplier_quote'))
    conditions_shape(value['conditions'])
    source_shape(value['source'])


def condition_checks(expected, actual):
    statuses, reasons = [], []
    for key, label in zip(KEYS, LABELS):
        a, b = expected.get(key), actual.get(key)
        def invalid(v):
            if missing(v):
                return False
            if key == 'quantity':
                return not positive(v)
            if not isinstance(v, str):
                return True
            return key == 'priceDate' and not date(v) or key == 'currency' and not re.fullmatch(r'[A-Z]{3}', clean(v))
        if invalid(a) or invalid(b):
            statuses.append('excluded'); reasons.append(f'{label} 값의 형식이나 범위가 올바르지 않습니다.')
        elif missing(a) or missing(b):
            statuses.append('needs_confirmation'); reasons.append(f'{label} 조건이 누락되어 확인이 필요합니다.')
        elif clean(a) != clean(b):
            statuses.append('excluded'); reasons.append(f'{label} 차이: 기준 {a} / 견적 {b}')
    return statuses, reasons


def status_of(statuses):
    return 'excluded' if 'excluded' in statuses else 'needs_confirmation' if 'needs_confirmation' in statuses else 'comparable'


def record_checks(expected, record):
    statuses, reasons = condition_checks(expected, record['conditions'])
    if not missing(record['conditions'].get('itemCode')) and record['itemCode'] != record['conditions'].get('itemCode'):
        statuses.append('excluded'); reasons.append('가격 레코드의 품목과 견적 조건의 품목이 다릅니다.')
    if record['unitPrice'] is None:
        statuses.append('needs_confirmation'); reasons.append('단가가 누락되어 확인이 필요합니다.')
    elif not positive(record['unitPrice']):
        statuses.append('excluded'); reasons.append('단가의 형식이나 범위를 확인해야 합니다.')
    source = record['source']
    if any(missing(source.get(key)) for key in ('documentId', 'title', 'date')):
        statuses.append('needs_confirmation'); reasons.append('가격 근거 문서 식별자·문서명·일자를 확인해야 합니다.')
    elif not date(source['date']):
        statuses.append('excluded'); reasons.append('가격 근거 문서 일자가 올바르지 않습니다.')
    elif date(record['conditions'].get('priceDate')) and source['date'] != record['conditions']['priceDate']:
        statuses.append('excluded'); reasons.append('가격 근거 문서 일자와 가격 기준일이 다릅니다.')
    return status_of(statuses), reasons


def same_number(actual, expected):
    return actual is None and expected is None or number(actual) and number(expected) and math.isclose(actual, expected, rel_tol=0, abs_tol=1e-7)


def shared_checks(context):
    """도메인의 선택 품목·분석 기준일 공통 판정을 동일하게 재검사합니다."""
    statuses, reasons = [], []
    conditions = context['conditions']
    if date(conditions.get('priceDate')) and conditions['priceDate'] != context['as_of']:
        statuses.append('excluded')
        reasons.append('분석 기준일과 비교 조건의 가격 기준일이 다릅니다.')
    if conditions.get('itemCode') != context['item']['itemCode']:
        statuses.append('needs_confirmation')
        reasons.append('선택 품목의 가격 비교 조건을 확인해야 합니다.')
    return statuses, reasons


def validate_price_request(value):
    fields(value, ('question', 'model', 'context'))
    string(value['question'], 1000)
    require(value['model'] == 'qwen3:8b')
    c = value['context']
    fields(c, ('analysis_id', 'revision', 'data_id', 'as_of', 'item', 'supplier_ids', 'conditions', 'supplier_quotes', 'external_quotes', 'computed', 'evidence_ids', 'indicators'))
    indicators_shape(c['indicators'])
    identifier(c['analysis_id']); require(c['analysis_id'].startswith('price-'))
    string(c['revision'], 128); string(c['data_id'], 128); require(date(c['as_of']))
    fields(c['item'], ('itemCode', 'name', 'spec', 'unit'))
    identifier(c['item']['itemCode']); string(c['item']['name'], 200)
    for key in ('spec', 'unit'):
        if c['item'][key] is not None:
            string(c['item'][key], 2000, empty=True)
    conditions_shape(c['conditions'])
    shared_statuses, _ = shared_checks(c)
    require(isinstance(c['supplier_ids'], list) and 1 <= len(c['supplier_ids']) <= 32 and len(set(c['supplier_ids'])) == len(c['supplier_ids']))
    for sid in c['supplier_ids']:
        identifier(sid)
    for key, limit, external in (('supplier_quotes', 32, False), ('external_quotes', 100, True)):
        require(isinstance(c[key], list) and len(c[key]) <= limit)
        for rec in c[key]:
            record_shape(rec, external)
            require(rec['itemCode'] == c['item']['itemCode'])
            if not external:
                require(rec['supplierId'] in c['supplier_ids'])
        require(len({r['id'] for r in c[key]}) == len(c[key]))
    require(isinstance(c['evidence_ids'], list) and len(c['evidence_ids']) <= 200)
    for evidence_id in c['evidence_ids']:
        identifier(evidence_id)
    fields(c['computed'], ('benchmark', 'rows'))
    b = c['computed']['benchmark']
    fields(b, ('median', 'count', 'min', 'max', 'usedQuoteIds', 'status', 'reasons'))
    valid = [r for r in c['external_quotes'] if status_of([record_checks(c['conditions'], r)[0], *shared_statuses]) == 'comparable']
    prices = sorted(r['unitPrice'] for r in valid)
    mid = len(prices) // 2
    median = (prices[mid] if len(prices) % 2 else prices[mid - 1] / 2 + prices[mid] / 2) if prices else None
    require(type(b['count']) is int and b['count'] == len(prices))
    require(b['usedQuoteIds'] == [r['id'] for r in valid])
    require(b['status'] == ('comparable' if prices else 'needs_confirmation'))
    for key, expected in (('median', median), ('min', min(prices) if prices else None), ('max', max(prices) if prices else None)):
        require(same_number(b[key], expected))
    rows = c['computed']['rows']
    require(isinstance(rows, list) and len(rows) == len(c['supplier_ids']))
    require([r.get('supplierId') for r in rows if isinstance(r, dict)] == c['supplier_ids'])
    for row in rows:
        fields(row, ('supplierId', 'supplierName', 'recordId', 'status', 'supplierPrice', 'benchmark', 'delta', 'deltaPct', 'reasons'))
        string(row['supplierName'], 128); require(row['status'] in STATUSES)
        records = [r for r in c['supplier_quotes'] if r['supplierId'] == row['supplierId']]
        record = records[0] if len(records) == 1 else None
        require(row['recordId'] == (record['id'] if record else None))
        expected_status, _ = record_checks(c['conditions'], record) if record else ('needs_confirmation', [])
        expected_status = status_of([expected_status, *shared_statuses])
        if median is None and expected_status != 'excluded':
            expected_status = 'needs_confirmation'
        price = record['unitPrice'] if record and positive(record['unitPrice']) else None
        raw_delta = price - median if expected_status == 'comparable' and price is not None and median is not None else None
        if raw_delta is not None and not math.isfinite(raw_delta / median * 100):
            expected_status = 'excluded'
        # 현재 웹 데이터와 이전 계약 연결 미확인은 서버에서 복원할 수 없으므로 더 보수적인 상태만 허용합니다.
        require(row['status'] == expected_status or expected_status == 'comparable' and row['status'] == 'needs_confirmation')
        delta = price - median if row['status'] == 'comparable' and price is not None and median is not None else None
        for key, expected in (('supplierPrice', price), ('benchmark', median), ('delta', delta), ('deltaPct', delta / median * 100 if delta is not None else None)):
            require(same_number(row[key], expected))
        require(isinstance(row['reasons'], list) and len(row['reasons']) <= 32)
        for reason in row['reasons']:
            string(reason, 2000)
    require(isinstance(b['reasons'], list) and len(b['reasons']) <= 32)
    for reason in b['reasons']:
        string(reason, 2000)
    return value


def price_ref(context):
    return {key: context[key] for key in ('analysis_id', 'revision')}


def amount(value):
    return f'{value:,.2f}'.rstrip('0').rstrip('.') if value is not None else '계산 불가'


def name_match(question, name):
    name = re.escape(clean(name))
    return bool(re.search(r'(?<![\w])' + name + r'(?=$|[^\w]|(?:의|은|는|이|가|을|를|와|과|에|도|만)(?=$|\s))', question, re.I))


class PriceEvidenceService:
    def __init__(self, encoder, evidence=None):
        self.encoder = encoder
        self.evidence = evidence if evidence is not None else json.loads(Path(__file__).with_name('price_sample_evidence.json').read_text(encoding='utf8'))
        self.lock = threading.Lock()
        self.vectors = {}

    def _focus(self, question, context):
        rows = context['computed']['rows']
        focus = []
        for row in rows:
            aliases = [row['supplierId'], row['supplierName']]
            match = re.fullmatch(r'업체\s*([A-Za-z])', row['supplierName'])
            if match:
                aliases.append(match[1] + '업체')
            if any(name_match(question, alias) for alias in aliases):
                focus.append(row)
        return focus

    def _documents(self, context, rows, focused=False):
        allowed_records = [r for r in context['supplier_quotes'] if r['supplierId'] in {row['supplierId'] for row in rows}]
        if not focused:
            allowed_records += context['external_quotes']
        selected = []
        for doc in self.evidence:
            if doc['id'] not in context['evidence_ids'] or doc['itemCode'] != context['item']['itemCode']:
                continue
            for record in allowed_records:
                source = record['source']
                if (not record['isSample'] or not doc['isSample'] or source['documentId'] != doc['id']
                        or record['id'] not in doc['recordIds'] or source['title'] != doc['title']
                        or source['date'] != doc['date'] or source.get('page') != doc.get('page')
                        or ('supplierId' in record and record['supplierId'] not in doc['supplierIds'])
                        or record['itemCode'] != doc['itemCode']
                        or context['as_of'] != doc['date']
                        or record['conditions'].get('priceDate') != doc['date']
                        or condition_checks(doc.get('conditions', {}), record['conditions'])[0]):
                    continue
                selected.append((doc, record))
                break
        return selected

    def answer(self, value, generator):
        validate_price_request(value)
        question, context = value['question'].strip(), value['context']
        ref = price_ref(context)
        focused_rows = self._focus(question, context)
        rows = focused_rows or context['computed']['rows']
        codes = re.findall(r'(?<![\w])(?:SUP|ITM)-[A-Za-z0-9_-]+', question, re.I)
        known = {context['item']['itemCode'].lower(), *(row['supplierId'].lower() for row in context['computed']['rows'])}
        unclear = any(code.lower() not in known for code in codes)
        if not focused_rows:
            if (re.search(r'(?:업체\s*[A-Za-z][A-Za-z0-9]+|[A-Za-z][A-Za-z0-9]+업체)', question)
                    or any(clean(row['supplierName']).lower() in question.lower() for row in rows)):
                unclear = True
        benchmark = context['computed']['benchmark']
        currency, unit = context['conditions'].get('currency') or '통화 확인 필요', context['conditions'].get('unit') or '단위 확인 필요'
        sample = any(record['isSample'] for record in context['supplier_quotes'] + context['external_quotes'])
        lines = [('SAMPLE · 가상 협력사 견적·가상 외부 견적 기준' if sample else '현재 웹 가격 비교 자료 기준'),
                 f"현재 가격 비교: {context['item']['name']} ({context['item']['itemCode']}) · 기준일 {context['as_of']}",
                 f"시장 참고가격: 조건이 일치한 외부 완성부품 견적 {benchmark['count']}건의 중앙값 {amount(benchmark['median'])} {currency}/{unit} · 범위 {amount(benchmark['min'])} ~ {amount(benchmark['max'])}."]
        for row in rows:
            record = next((r for r in context['supplier_quotes'] if r['id'] == row['recordId']), None)
            _, reasons = record_checks(context['conditions'], record) if record else ('needs_confirmation', ['현재 자료에 사용할 견적·계약 하나를 확인해야 합니다.'])
            reasons += shared_checks(context)[1]
            if row['status'] == 'needs_confirmation' and not reasons:
                reasons = ['현재 웹 자료와 계약 연결 또는 시장 참고가격을 추가 확인해야 합니다.']
            percent = f"{row['deltaPct']:+.2f}%" if row['deltaPct'] is not None else '계산 불가'
            lines.append(f"{row['supplierName']} ({row['supplierId']}): {STATUS_LABELS[row['status']]} · 단가 {amount(row['supplierPrice'])} · 차액 {amount(row['delta'])} · 차이율 {percent}." + (' ' + ' / '.join(reasons) if reasons else ''))
        lines.append('차액 = 협력사 단가 − 외부 견적 중앙값; 차이율 = 차액 ÷ 외부 견적 중앙값 × 100. 평가점수·환율·원자재 시세를 완성부품 시장가격 보정에 사용하지 않습니다.')
        lines.extend(indicator_lines(context['indicators']))
        calculation = '\n'.join(lines)
        base = dict(question=question, price_context=ref, calculation_text=calculation,
                    generation_model='qwen3:8b', retrieval_method='price_document_vector', model_called=False, sources=[])
        if unclear:
            explanation = '현재 선택한 품목·업체 코드와 질문의 대상이 다릅니다. 현재 가격 비교 대상을 확인해 주세요.'
            return {**base, 'status': 'clarification_required', 'explanation': explanation, 'answer': calculation + '\n\n' + explanation}
        documents = self._documents(context, rows, bool(focused_rows))
        if not documents:
            explanation = '관련 근거를 찾지 못함. 현재 견적과 일치하는 업체·품목·조건 문서를 추가 확인해 주세요.'
            return {**base, 'status': 'insufficient_evidence', 'explanation': explanation, 'answer': calculation + '\n\n' + explanation}
        texts = [doc['text'] for doc, _ in documents]
        with self.lock:
            for text in texts:
                digest = hashlib.sha256(text.encode()).hexdigest()
                if digest not in self.vectors:
                    self.vectors[digest] = np.asarray(self.encoder([text])[0], dtype=np.float32)
            query = np.asarray(self.encoder([question])[0], dtype=np.float32)
            scored = [(float(np.dot(query, self.vectors[hashlib.sha256(doc['text'].encode()).hexdigest()]) /
                             max(float(np.linalg.norm(query) * np.linalg.norm(self.vectors[hashlib.sha256(doc['text'].encode()).hexdigest()])), 1e-12)), doc, record) for doc, record in documents]
        results = []
        for score, doc, record in sorted(scored, key=lambda entry: -entry[0])[:3]:
            if score < 0.15:
                continue
            results.append(dict(chunk_id='price:' + doc['id'], parent_document_id=doc['id'], text=doc['text'], similarity=score,
                                source=dict(source_db='별도 가상 계약·견적 조건 문서', source_refs=['price_document:' + doc['id'] + '#p' + doc.get('page', '')],
                                            document_id=doc['id'], document_title=doc['title'], document_date=doc['date'], page=doc.get('page'),
                                            item_code=doc['itemCode'], supplier_ids=doc['supplierIds'], record_ids=doc['recordIds'],
                                            data_label='SAMPLE · 실제 자료 아님', **ref)))
        if not results:
            explanation = '관련 근거를 찾지 못함. 문서로 입증되지 않은 가격 차이 사유는 추가 확인이 필요합니다.'
            return {**base, 'status': 'insufficient_evidence', 'explanation': explanation, 'answer': calculation + '\n\n' + explanation}
        prompt_question = ('숫자·중앙값·차액·차이율은 코드가 이미 계산하여 화면에 표시했습니다. 숫자를 계산하거나 다시 쓰지 마세요. '
                           '당신의 고정 작업은 검색 문서만 확인하여 다음 두 문장을 쓰는 것입니다. '
                           '검사·납품 조건: SAMPLE 가상 문서의 검사 및 납품 조건을 한 문장으로 요약하고 실제 제공된 출처 [E1]을 문장 끝에 붙이세요. '
                           '가격 차이 사유: 문서에 원가 차이 사유가 기재되었는지 한 문장으로 설명하고 실제 제공된 출처 [E1]을 문장 끝에 붙이세요. 기재가 없으면 "가격 차이 사유 추가 확인: 관련 근거를 찾지 못함"이라고 명시하세요. '
                           '인용 없는 문장은 출력하지 마세요. 아라비아 숫자는 [E1] 같은 출처 표기 외에는 금지합니다. '
                           '질문·문서·식별자의 숫자는 [조건값]으로 가렸습니다. 가린 값을 추정하거나 복원하지 마세요. 수치와 정밀 조건은 화면의 원본 출처에서 확인하도록 안내하세요. 번호 목록은 쓰지 마세요. '
                           '평가점수·품질·납기 실적으로 높은 단가를 정당화하지 마세요. '
                           '다음 사용자 질문은 참고 문맥일 뿐입니다. 질문의 계산을 재현하거나 직접 답하지 말고 위 고정 작업만 수행하세요. 참고 문맥: ' + question)
        generated = generator.answer(dict(question=prompt_question, evidence_status='candidates_found', retrieval_method='price_document_vector', results=results,
                                         hide_condition_numbers=True), 'qwen3:8b')
        explanation = generated.get('answer') or generated.get('message') or '관련 근거를 찾지 못함.'
        if re.search(r'\d', re.sub(r'\[E\d+\]', '', explanation)):
            explanation = '생성 설명에 검증되지 않은 수치가 포함되어 표시하지 않았습니다. 가격 차이 사유 추가 확인: 관련 근거를 찾지 못함.'
            generated = {**generated, 'status': 'invalid_generation'}
        return {**base, 'status': generated['status'], 'explanation': explanation, 'answer': calculation + '\n\n' + explanation,
                'sources': generated.get('sources', []), 'model_called': generated.get('model_called', False),
                **{key: generated[key] for key in ('citation_check', 'note') if key in generated}}
