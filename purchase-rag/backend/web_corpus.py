"""웹의 현재 스냅샷을 방문자별 메모리에서만 검색합니다. 파일/기존 DB는 쓰지 않습니다."""
from __future__ import annotations

import hashlib
import hmac
import json
import math
import re
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import numpy as np

SCHEMAS = json.loads(Path(__file__).with_name('web_schema.json').read_text(encoding='utf8'))
MAX_UPLOAD_BYTES = 2 * 1024 * 1024
MAX_ROWS = 2000
MAX_CHUNKS = 2048
MAX_SESSIONS = 8
MAX_MEMORY = 128 * 1024 * 1024
TTL_SECONDS = 30 * 60
CHUNK_CHARS = 800
# 웹 문서에만 적용하는 보수적인 검색 하한. 기존 가상 DB의 보정값을 재사용하지 않습니다.
WEB_MIN_SIMILARITY = .55
OWNER = re.compile(r'[0-9a-f]{64}')
REVISION = re.compile(r'[0-9a-f]{64}')
CODE = re.compile(r'(?<![A-Za-z0-9_-])(?:[A-Za-z][A-Za-z0-9]{0,15}[-_])+(?:[A-Za-z0-9][A-Za-z0-9_-]*)(?![A-Za-z0-9_-])')
TABLE_TERMS = [
    ('purchaseOrders', ('발주', '구매조달', '납기', '입고')),
    ('contracts', ('계약', '인도 조건', '결제 조건')),
    ('inventory', ('재고', '안전재고', '보관', '창고')),
    ('fxRates', ('환율',)), ('laborWages', ('임금', '인건비', '직종')),
    ('materialPrices', ('시세', '원자재 가격')),
    ('competitorSupply', ('경쟁사', '공급 동향')),
    ('industryNews', ('기사', '뉴스', '업계', '동향')),
    ('bom', ('bom', '분류 경로', '대부품', '중부품', '엔진 모델')),
    ('items', ('품목 마스터', '품목명', '부품명', '규격')),
    ('suppliers', ('협력사', '협력업체', '업체', '품질', '불량률', '심사', '등급')),
]
AGGREGATE = re.compile(r'합계|총\s*(?:수량|금액|액|건|개|발주|재고|비용)|평균|최[대소고저]|가장|순위|상위|하위|몇\s*(?:건|개|곳)|비교|추이|증감|증가율|감소율|비중|계산|준수율|전체.*(?:수량|금액|건수|합|몇)|건수')
DATE_CONDITION = re.compile(r'(?<!\d)\d{4}[-./]\d{1,2}(?:[-./]\d{1,2})?(?!\d)|(?<!\d)\d{4}\s*년|(?<!\d)(?:[1-9]|1[0-2])\s*월|올해|작년|재작년|금년|전년|지난해|이번\s*(?:달|월|년|분기)|지난\s*(?:달|월|해|년|분기)|최근\s*\d*\s*(?:일|주|개월|달|년)|기간|이후|이전|부터|까지|상반기|하반기|분기')
NUMERIC_RANGE = re.compile(r'[+-]?\d[\d,.]*\s*(?:[가-힣%]|kg|t){0,8}\s*(?:이상|이하|초과|미만)', re.IGNORECASE)
NAME_PARTICLE = re.compile(r'(?:에게서|으로부터|로부터|에서는|에서도|에게|한테|으로|부터|까지|께서|에는|에도|의|은|는|이|가|을|를|와|과|로|에|도|만)(?=$|[^\w])')


def name_matches(name, question):
    """이름 앞뒤의 단어 경계를 확인하되, 분리된 한국어 조사는 허용합니다."""
    for match in re.finditer(re.escape(name), question):
        before = question[match.start() - 1] if match.start() else ''
        if before and (before.isalnum() or before == '_'):
            continue
        tail = question[match.end():]
        if not tail or (not tail[0].isalnum() and tail[0] != '_') or NAME_PARTICLE.match(tail):
            return True
    return False


class WebCorpusError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message
        super().__init__(message)


def invalid():
    raise WebCorpusError(422, '웹 데이터의 필드·자료형·키·날짜·범위를 확인해 주세요.')


def text(value, maximum=2000, required=False):
    if not isinstance(value, str) or len(value) > maximum or any(ord(c) < 32 and c not in '\n\t' for c in value):
        invalid()
    if required and not value.strip():
        invalid()
    return value


def is_day(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        return False
    try:
        return date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def validate_field(value, definition):
    if value is None:
        if definition.get('required'):
            invalid()
        return
    kind = definition['type']
    if kind == 'number':
        if type(value) not in (int, float) or not math.isfinite(value) or abs(value) > 1e15:
            invalid()
        if value < definition.get('min', -1e15) or value > definition.get('max', 1e15):
            invalid()
    elif kind == 'boolean':
        if type(value) is not bool:
            invalid()
    elif kind == 'date':
        if not is_day(value):
            invalid()
    elif kind == 'month':
        if not isinstance(value, str) or not re.fullmatch(r'\d{4}-(?:0[1-9]|1[0-2])', value) or value.startswith('0000'):
            invalid()
    elif kind == 'grade':
        if not isinstance(value, str) or value not in ('A', 'B', 'C', 'D'):
            invalid()
    elif kind == 'list':
        if not isinstance(value, list) or len(value) > 100:
            invalid()
        for item in value:
            text(item, 200, True)
    elif kind == 'history':
        if not isinstance(value, list) or len(value) > 50:
            invalid()
        for item in value:
            if not isinstance(item, dict) or set(item) - {'year', 'half', 'grade', 'score', 'reason'} or not {'year', 'grade', 'score'} <= set(item):
                invalid()
            if type(item['year']) is not int or not 1900 <= item['year'] <= 2200 or (item.get('half') is not None and (type(item['half']) is not int or item['half'] not in (1, 2))):
                invalid()
            validate_field(item['grade'], {'type': 'grade', 'required': True})
            validate_field(item['score'], {'type': 'number', 'required': True, 'min': 0, 'max': 100})
            if item.get('reason') is not None:
                text(item['reason'], 1000)
    else:
        text(value, 2000, definition.get('required', False))


def dataset_handle(value):
    if not isinstance(value, dict) or set(value) != {'id', 'revision'}:
        invalid()
    try:
        if not isinstance(value['id'], str) or str(uuid.UUID(value['id'])) != value['id'] or not isinstance(value['revision'], str) or not REVISION.fullmatch(value['revision']):
            invalid()
    except (ValueError, TypeError, AttributeError):
        invalid()
    return {'id': value['id'], 'revision': value['revision']}


def owner_value(value):
    if not isinstance(value, str) or not OWNER.fullmatch(value):
        invalid()
    return value


def key_of(schema, row):
    keys = schema['primaryKey']
    keys = keys if isinstance(keys, list) else [keys]
    return '|'.join(str(row.get(key, '')) for key in keys)


def prepare(payload):
    if not isinstance(payload, dict) or set(payload) != {'schema_version', 'client_revision', 'meta', 'data'}:
        invalid()
    if type(payload['schema_version']) is not int or payload['schema_version'] != 1:
        invalid()
    text(payload['client_revision'], 200, True)
    meta, data = payload['meta'], payload['data']
    if not isinstance(meta, dict) or set(meta) != {'asOf', 'isSample', 'label', 'sources', 'uploaded'}:
        invalid()
    if not is_day(meta['asOf']) or type(meta['isSample']) is not bool:
        invalid()
    text(meta['label'], 200, True)
    if not isinstance(meta['sources'], dict) or set(meta['sources']) - SCHEMAS.keys():
        invalid()
    for filename in meta['sources'].values():
        text(filename, 255, True)
    if not isinstance(meta['uploaded'], list) or len(meta['uploaded']) > len(SCHEMAS) or any(not isinstance(k, str) or k not in SCHEMAS for k in meta['uploaded']) or len(set(meta['uploaded'])) != len(meta['uploaded']):
        invalid()
    if not isinstance(data, dict) or set(data) != set(SCHEMAS) or any(not isinstance(rows, list) for rows in data.values()):
        invalid()
    count = sum(len(rows) for rows in data.values())
    if count > MAX_ROWS:
        raise WebCorpusError(413, '웹 RAG는 전체 2000행까지 연결할 수 있습니다. 데이터 범위를 줄여 주세요.')
    if count == 0:
        raise WebCorpusError(422, '검색할 웹 데이터가 없습니다. 먼저 데이터를 불러와 주세요.')
    try:
        canonical = json.dumps({'schema_version': 1, 'meta': meta, 'data': data}, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf8')
    except (ValueError, TypeError, UnicodeError):
        invalid()
    if len(canonical) > MAX_UPLOAD_BYTES:
        raise WebCorpusError(413, '웹 데이터 전송 한도 2MiB를 넘었습니다. 데이터 범위를 줄여 주세요.')
    revision = hashlib.sha256(canonical).hexdigest()
    # 현재 스냅샷은 샘플에 업로드를 병합할 수 있어, 업로드 표의 모든 행을 실자료로 단정하지 않습니다.
    label = 'SAMPLE + 업로드 데이터' if meta['uploaded'] else ('SAMPLE 데이터' if meta['isSample'] else meta['label'])
    chunks = []
    for table, schema in SCHEMAS.items():
        fields = {f['key']: f for f in schema['fields']}
        seen = set()
        for row in data[table]:
            if not isinstance(row, dict) or set(row) - fields.keys():
                invalid()
            for key, definition in fields.items():
                if key not in row:
                    if definition.get('required'):
                        invalid()
                else:
                    validate_field(row[key], definition)
            record_key = key_of(schema, row)
            text(record_key, 300, True)
            if record_key in seen or any(not isinstance(row.get(k), str) or not row[k].strip() for k in (schema['primaryKey'] if isinstance(schema['primaryKey'], list) else [schema['primaryKey']])):
                invalid()
            seen.add(record_key)
            source = {'source_db': '웹 화면 데이터', 'source_refs': [f'web:{table}:{record_key}'],
                      'dataset_key': table, 'record_key': record_key, 'revision': revision,
                      'source_file': meta['sources'].get(table, '웹 현재 스냅샷'),
                      'source_file_scope': '표의 마지막 업로드 파일명이며 개별 행의 원본 파일을 뜻하지 않습니다.',
                      'data_label': label, 'as_of': meta['asOf']}
            header = f'[웹 화면 데이터: {schema["label"]}]\n행 키: {record_key}\n자료 구분: {label}\n'
            lines = []
            for key, value in row.items():
                if value is None:
                    rendered = '미입력'
                elif isinstance(value, (list, dict)):
                    rendered = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
                elif isinstance(value, bool):
                    rendered = '예' if value else '아니오'
                else:
                    rendered = str(value)
                lines.append(f'{fields[key]["label"]}({key}): {rendered}')
            body = '\n'.join(lines)
            # 행 키·표 이름은 모든 청크에 반복합니다. 숫자·문자열은 원문 그대로 유지합니다.
            pieces = []
            current = ''
            for line in lines:
                for start in range(0, len(line), CHUNK_CHARS - len(header)):
                    segment = line[start:start + CHUNK_CHARS - len(header)]
                    if current and len(current) + len(segment) + 1 > CHUNK_CHARS - len(header):
                        pieces.append(current)
                        current = ''
                    current += ('\n' if current else '') + segment
            if current:
                pieces.append(current)
            identities = {str(row[key]).casefold() for key in ('supplierId', 'itemCode', 'poNo', 'contractId', 'mainSupplierId') if isinstance(row.get(key), str) and row[key]}
            identities.update(item.casefold() for key in ('items',) for item in row.get(key, []) if isinstance(item, str))
            names = {row[key].casefold() for key in ('name', 'competitor', 'supplierName', 'material', 'title') if isinstance(row.get(key), str) and len(row[key]) >= 2}
            named_identity = (row.get('name', '').casefold(), row.get('supplierId' if table == 'suppliers' else 'itemCode', '').casefold()) if table in ('suppliers', 'items') else None
            for index, piece in enumerate(pieces):
                chunks.append({'chunk_id': f'web:{table}:{record_key}:{index}', 'parent_document_id': f'web:{table}:{record_key}',
                               'text': header + piece, 'source': source, 'table': table,
                               'identities': identities, 'names': names, 'named_identity': named_identity})
            if len(chunks) > MAX_CHUNKS:
                raise WebCorpusError(413, '웹 데이터 청크 한도 2048개를 넘었습니다. 긴 내용을 줄여 주세요.')
    # numpy float32 벡터 + 문자열/메타데이터/검색용 집합의 보수적 예약량.
    memory = len(canonical) * 4 + sum(len(c['text'].encode('utf8')) * 4 + 4096 for c in chunks) + len(chunks) * 1024 * 4
    return revision, chunks, count, memory


@dataclass
class Corpus:
    id: str
    owner: str
    revision: str
    row_count: int
    chunks: list
    expires: float
    memory: int
    status: str = 'indexing'
    vectors: np.ndarray | None = None
    message: str | None = None


class WebCorpusRegistry:
    def __init__(self, encoder, *, clock=time.monotonic, ttl=TTL_SECONDS, max_sessions=MAX_SESSIONS, max_memory=MAX_MEMORY, min_similarity=WEB_MIN_SIMILARITY):
        self.encoder, self.clock, self.ttl = encoder, clock, ttl
        self.max_sessions, self.max_memory = max_sessions, max_memory
        self.min_similarity = min_similarity
        self.lock = threading.RLock()
        self.items = {}
        self.indexing = None
        self.reserved = 0
        self._cleanup_stop = threading.Event()
        self._cleanup_thread = None

    def sweep(self):
        """요청이 없어도 등록 시각 기준 TTL이 지난 원문·벡터 참조를 제거합니다."""
        with self.lock:
            self._expire()

    def start_cleanup(self, interval=60):
        """운영 registry에서만 명시적으로 시작합니다. 테스트 인스턴스는 자동 실행하지 않습니다."""
        if interval <= 0:
            raise ValueError('cleanup interval must be positive')
        with self.lock:
            if self._cleanup_thread is not None and self._cleanup_thread.is_alive():
                return
            self._cleanup_stop.clear()
            def clean():
                while not self._cleanup_stop.wait(interval):
                    self.sweep()
            self._cleanup_thread = threading.Thread(target=clean, daemon=True, name='web-rag-memory-ttl-cleanup')
            self._cleanup_thread.start()

    def stop_cleanup(self):
        self._cleanup_stop.set()
        thread = self._cleanup_thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=1)

    def _expire(self):
        for key, corpus in list(self.items.items()):
            if corpus.expires <= self.clock():
                del self.items[key]

    @staticmethod
    def public(corpus):
        value = {'dataset_id': corpus.id, 'revision': corpus.revision, 'status': corpus.status,
                 'row_count': corpus.row_count, 'chunk_count': len(corpus.chunks)}
        if corpus.message:
            value['message'] = corpus.message
        return value

    def _get(self, owner, dataset_id, revision=None, ready=False):
        self._expire()
        corpus = self.items.get(dataset_id)
        if corpus is None or not hmac.compare_digest(corpus.owner, owner):
            raise WebCorpusError(404, '웹 데이터 연결이 없거나 만료되었습니다. 현재 데이터를 다시 연결해 주세요.')
        if revision is not None and not hmac.compare_digest(corpus.revision, revision):
            raise WebCorpusError(409, '웹 데이터가 변경되었습니다. 현재 데이터를 다시 연결해 주세요.')
        if ready and corpus.status != 'ready':
            raise WebCorpusError(409, '웹 데이터 인덱싱이 완료되지 않았습니다. 연결 상태를 확인해 주세요.')
        return corpus

    def create(self, payload, owner):
        owner_value(owner)
        revision, chunks, count, memory = prepare(payload)
        with self.lock:
            self._expire()
            if self.indexing is not None:
                raise WebCorpusError(429, '다른 웹 데이터의 인덱싱이 진행 중입니다. 잠시 후 다시 연결해 주세요.')
            previous = [c for c in self.items.values() if c.owner == owner]
            others = [c for c in self.items.values() if c.owner != owner]
            if len(others) >= self.max_sessions or sum(c.memory for c in others) + memory + self.reserved > self.max_memory:
                raise WebCorpusError(429, '웹 데이터 메모리 보관 한도에 도달했습니다. 잠시 후 다시 연결해 주세요.')
            corpus = Corpus(str(uuid.uuid4()), owner, revision, count, chunks, self.clock() + self.ttl, memory)
            for chunk in chunks:
                chunk['source']['dataset_id'] = corpus.id
            self.items[corpus.id] = corpus
            self.indexing = corpus.id
            self.reserved = memory
            try:
                threading.Thread(target=self._index, args=(corpus,), daemon=True, name='web-rag-memory-index').start()
            except RuntimeError:
                del self.items[corpus.id]
                self.indexing, self.reserved = None, 0
                raise WebCorpusError(503, '웹 데이터 인덱싱을 시작하지 못했습니다. 다시 연결해 주세요.') from None
            for old in previous:
                del self.items[old.id]
            return self.public(corpus)

    def _index(self, corpus):
        try:
            batches = []
            for start in range(0, len(corpus.chunks), 8):
                with self.lock:
                    self._expire()
                    if self.items.get(corpus.id) is not corpus:
                        return
                # 실행 중인 한 배치는 멈추지 않고, 삭제·만료 후의 남은 계산을 시작하지 않습니다.
                batches.append(self._encode([chunk['text'] for chunk in corpus.chunks[start:start + 8]]))
            with self.lock:
                self._expire()
                if self.items.get(corpus.id) is corpus:
                    corpus.vectors, corpus.status = np.vstack(batches), 'ready'
        except Exception:
            with self.lock:
                if self.items.get(corpus.id) is corpus:
                    corpus.status = 'failed'
                    corpus.message = '웹 데이터 인덱싱에 실패했습니다. 모델 실행 상태와 데이터 크기를 확인해 주세요.'
        finally:
            with self.lock:
                if self.indexing == corpus.id:
                    self.indexing, self.reserved = None, 0

    def _encode(self, texts):
        vectors = np.asarray(self.encoder(texts), dtype=np.float32)
        if vectors.shape != (len(texts), 1024) or not np.isfinite(vectors).all():
            raise ValueError('invalid embedding')
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        if np.any(norms == 0):
            raise ValueError('empty embedding')
        return vectors / norms

    def status(self, owner, dataset_id):
        owner_value(owner)
        with self.lock:
            return self.public(self._get(owner, dataset_id))

    def delete(self, owner, dataset_id):
        owner_value(owner)
        with self.lock:
            self._get(owner, dataset_id)
            del self.items[dataset_id]
            return {'deleted': True}

    def search(self, owner, handle, question, top_k=3):
        owner_value(owner)
        handle = dataset_handle(handle)
        text(question, 1000, True)
        if type(top_k) is not int or not 1 <= top_k <= 10:
            invalid()
        with self.lock:
            corpus = self._get(owner, handle['id'], handle['revision'], True)
            chunks, vectors = corpus.chunks, corpus.vectors
        common = {'question': question, 'retrieval_method': 'web_memory', 'results': [], 'count': 0,
                  'evidence_status': 'insufficient_evidence', 'message': '현재 웹 데이터에서 관련 근거를 찾을 수 없습니다.'}
        # 코드 안의 PO-2026-0059 같은 숫자는 날짜 조건으로 해석하지 않습니다.
        conditions_text = CODE.sub(' ', question)
        if DATE_CONDITION.search(conditions_text) or NUMERIC_RANGE.search(conditions_text):
            return {**common, 'evidence_status': 'clarification_required',
                    'message': '웹 RAG는 날짜·기간 조건이나 수치 범위를 아직 검증하지 않습니다. 웹 화면에서 먼저 조건을 확인하거나 조건 없이 특정 행의 저장된 값을 질문해 주세요.'}
        aggregate_text = re.sub(r'월평균\s*(?:임금|환율)', '', question)
        if AGGREGATE.search(aggregate_text):
            return {**common, 'evidence_status': 'clarification_required',
                    'message': '웹 RAG는 전체 합계·평균·순위·비교를 부분 검색으로 계산하지 않습니다. 웹 데이터 분석을 사용하거나 특정 행의 저장된 값을 질문해 주세요.'}
        lowered = question.casefold()
        table = next((table for table, terms in TABLE_TERMS if any(term in lowered for term in terms)), None)
        pool = [i for i, chunk in enumerate(chunks) if table is None or chunk['table'] == table]
        known_names = {name for chunk in chunks for name in chunk['names']}
        matching_names = {name for name in known_names if name_matches(name, lowered)}
        if any(name in lowered and name not in matching_names and not any(name in full for full in matching_names) for name in known_names):
            return {**common, 'evidence_status': 'clarification_required',
                    'message': '질문의 이름이 등록된 이름과 정확히 일치하지 않습니다. 업체ID·품목코드 또는 등록된 전체 이름을 지정해 주세요.'}
        codes = {match.casefold() for match in CODE.findall(question)}
        all_identities = set().union(*(chunk['identities'] for chunk in chunks))
        codes.update(identity for identity in all_identities if len(identity) >= 2 and re.search(r'(?<![A-Za-z0-9_-])' + re.escape(identity) + r'(?![A-Za-z0-9_-])', lowered))
        entity_names = {}
        for chunk in chunks:
            named = chunk['named_identity']
            if named and named[0] and named[0] in matching_names:
                entity_names.setdefault(named[0], set()).add(named[1])
        if any(len(ids) > 1 for ids in entity_names.values()):
            return {**common, 'evidence_status': 'clarification_required',
                    'message': '같은 이름의 웹 데이터가 여러 개 있습니다. 업체ID나 품목코드를 지정해 주세요.'}
        codes.update(identity for ids in entity_names.values() for identity in ids)
        if codes:
            pool = [i for i in pool if codes <= chunks[i]['identities']]
            if not pool:
                return common
        names = matching_names
        if names and not codes:
            matching = [i for i in pool if chunks[i]['names'] & names]
            pool = matching
        exact = bool(codes or names)
        if not pool:
            return common
        if exact:
            if len(pool) > top_k:
                return {**common, 'evidence_status': 'clarification_required',
                        'message': '조건에 맞는 웹 데이터가 검색 범위보다 많습니다. 발주번호·계약번호·표 이름 등으로 조회할 행을 좁혀 주세요.'}
            selected = [(i, None) for i in pool]
            method = 'web_exact_records'
        else:
            query = self._encode([question])[0]
            similarities = vectors[pool] @ query
            ordered = np.argsort(-similarities, kind='stable')[:top_k]
            selected = [(pool[int(i)], float(similarities[i])) for i in ordered if similarities[i] >= self.min_similarity]
            method = 'web_semantic'
        with self.lock:
            self._get(owner, handle['id'], handle['revision'], True)
        hits = [{key: chunks[i][key] for key in ('chunk_id', 'parent_document_id', 'text', 'source')} | {'similarity': None if similarity is None else round(similarity, 6)} for i, similarity in selected]
        return {**common, 'retrieval_method': method, 'results': hits, 'count': len(hits),
                'evidence_status': 'candidates_found' if hits else 'insufficient_evidence',
                'message': '웹 현재 스냅샷의 원본 행을 검색했습니다.' if hits else common['message']}

    def answer(self, owner, handle, question, model, top_k, generator):
        handle = dataset_handle(handle)
        result = generator.answer(self.search(owner, handle, question, top_k), model)
        with self.lock:
            self._get(owner, handle['id'], handle['revision'], True)
        return {**result, 'dataset': handle}
