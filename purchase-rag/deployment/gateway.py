"""인증된 비동기 질문 작업. 원본 백엔드와 Ollama는 외부에 직접 노출하지 않습니다."""
from __future__ import annotations

import hmac
import hashlib
import json
import math
import os
import re
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass
from typing import Literal

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, ValidationError, field_validator, model_validator

BACKEND_URL = 'http://127.0.0.1:8000'
MAX_BODY_BYTES = 8192
MAX_DATASET_BYTES = 2 * 1024 * 1024
JOB_TTL_SECONDS = 15 * 60
MAX_JOBS = 100
QUOTA_WINDOW_SECONDS = 600
VISITOR_JOB_LIMIT = 6
GLOBAL_JOB_LIMIT = 20
MAX_QUOTA_VISITORS = 1000
VISITOR_PATTERN = re.compile(r'[A-Za-z0-9_-]{43}')


class DatasetHandle(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: StrictStr
    revision: StrictStr = Field(pattern=r'^[0-9a-f]{64}$')

    @field_validator('id')
    @classmethod
    def valid_id(cls, value):
        if str(uuid.UUID(value)) != value:
            raise ValueError('invalid dataset id')
        return value


class AnswerInput(BaseModel):
    # backend.app.AnswerRequest와 같은 필드/범위. 배포 경계에서는 추가 필드와 타입 변환도 막습니다.
    model_config = ConfigDict(extra='forbid')
    question: StrictStr = Field(min_length=1, max_length=1000)
    model: Literal['qwen3:8b', 'gemma3:4b', 'llama3.1:8b']
    top_k: StrictInt = Field(default=3, ge=1, le=10)
    order_id: StrictInt | None = Field(default=None, gt=0)
    supplier_id: StrictInt | None = Field(default=None, gt=0)
    part_id: StrictInt | None = Field(default=None, gt=0)
    document_type: Literal['supplier', 'part', 'supplier_part', 'order', 'complaint'] | None = None
    dataset: DatasetHandle | None = None

    @model_validator(mode='after')
    def separate_sources(self):
        if self.dataset is not None and any(getattr(self, key) is not None for key in ('order_id', 'supplier_id', 'part_id', 'document_type')):
            raise ValueError('web and DB filters cannot be mixed')
        return self

    @field_validator('question')
    @classmethod
    def not_blank(cls, value):
        value = value.strip()
        if not value:
            raise ValueError('blank question')
        return value


class BackendUnavailable(Exception):
    def __init__(self, status_code=503, message='백엔드에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.'):
        self.status_code = status_code
        self.message = message


class LocalBackend:
    """고정된 로컬 주소/경로만 호출합니다. 사용자 URL/경로는 받지 않습니다."""
    def request(self, method, path, payload=None):
        allowed = {('GET', '/health'), ('GET', '/models'), ('POST', '/answer'),
                   ('POST', '/web/datasets'), ('POST', '/web/datasets/status'),
                   ('POST', '/web/datasets/delete'), ('POST', '/web/answer')}
        if (method, path) not in allowed:
            raise BackendUnavailable(502, '지원하지 않는 작업입니다.')
        try:
            with httpx.Client(base_url=BACKEND_URL, trust_env=False, follow_redirects=False,
                              timeout=httpx.Timeout(630 if path in ('/answer', '/web/answer') else 10, connect=3)) as client:
                response = client.request(method, path, json=payload)
            if not 200 <= response.status_code < 300:
                if path.startswith('/web/'):
                    messages = {404: '웹 데이터 연결이 없거나 만료되었습니다. 현재 데이터를 다시 연결해 주세요.',
                                409: '웹 데이터가 변경되었거나 준비되지 않았습니다. 현재 데이터를 다시 연결해 주세요.',
                                413: '웹 데이터 크기 한도를 넘었습니다. 데이터 범위를 줄여 주세요.',
                                422: '웹 데이터 필드·키·형식·범위를 확인해 주세요.',
                                429: '웹 데이터 처리 또는 메모리 보관 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.',
                                504: '답변 생성 시간이 초과되었습니다. 다시 시도해 주세요.'}
                    status = response.status_code if response.status_code in messages else 503
                    raise BackendUnavailable(status, messages.get(status, '웹 답변 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.'))
                if response.status_code == 504:
                    raise BackendUnavailable(504, '답변 생성 시간이 초과되었습니다. 다시 시도해 주세요.')
                if response.status_code in (400, 409, 422):
                    raise BackendUnavailable(400, '질문 조건을 처리하지 못했습니다. 질문이나 조회 범위를 확인해 주세요.')
                raise BackendUnavailable(503, '답변 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.')
            data = response.json()
            if not isinstance(data, dict):
                raise BackendUnavailable(502, '답변 서비스의 응답 형식이 올바르지 않습니다.')
            return data
        except BackendUnavailable:
            raise
        except httpx.TimeoutException as error:
            raise BackendUnavailable(504, '답변 생성 시간이 초과되었습니다. 다시 시도해 주세요.') from error
        except (httpx.RequestError, ValueError) as error:
            raise BackendUnavailable() from error


@dataclass
class Job:
    id: str
    owner_hash: str
    state: str = 'running'
    result: dict | None = None
    message: str | None = None
    error_status: int | None = None
    finished_at: float | None = None
    dataset: dict | None = None
    invalidated: bool = False


class Busy(Exception):
    pass


class QuotaExceeded(Exception):
    def __init__(self, message, retry_after):
        self.message = message
        self.retry_after = max(1, math.ceil(retry_after))


class Jobs:
    def __init__(self, backend, *, clock=time.monotonic, ttl=JOB_TTL_SECONDS, capacity=MAX_JOBS,
                 quota_window=QUOTA_WINDOW_SECONDS, visitor_limit=VISITOR_JOB_LIMIT,
                 global_limit=GLOBAL_JOB_LIMIT, max_quota_visitors=MAX_QUOTA_VISITORS):
        self.backend = backend
        self.clock = clock
        self.ttl = ttl
        self.capacity = capacity
        self.lock = threading.Lock()
        self.items: dict[str, Job] = {}
        self.active: str | None = None
        self.quota_window = quota_window
        self.visitor_limit = visitor_limit
        self.global_limit = global_limit
        self.max_quota_visitors = max_quota_visitors
        # 원래 방문자 쿠키 값은 저장하지 않습니다. 해시별로 수락 시각만 제한적으로 보관합니다.
        self.visitor_usage: dict[str, deque[float]] = {}
        self.global_usage: deque[float] = deque()

    def _expire(self):
        now = self.clock()
        expired = [key for key, job in self.items.items()
                   if job.finished_at is not None and now - job.finished_at >= self.ttl]
        for key in expired:
            del self.items[key]
        cutoff = now - self.quota_window
        while self.global_usage and self.global_usage[0] <= cutoff:
            self.global_usage.popleft()
        for owner in list(self.visitor_usage):
            usage = self.visitor_usage[owner]
            while usage and usage[0] <= cutoff:
                usage.popleft()
            if not usage:
                del self.visitor_usage[owner]

    def _check_quota(self, owner):
        now = self.clock()
        usage = self.visitor_usage.get(owner)
        if usage is not None and len(usage) >= self.visitor_limit:
            raise QuotaExceeded('이 브라우저의 질문 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.',
                                usage[0] + self.quota_window - now)
        if len(self.global_usage) >= self.global_limit:
            raise QuotaExceeded('전체 질문 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.',
                                self.global_usage[0] + self.quota_window - now)
        if usage is None and len(self.visitor_usage) >= self.max_quota_visitors:
            earliest = min(values[0] for values in self.visitor_usage.values())
            raise QuotaExceeded('이용 요청이 많습니다. 잠시 후 다시 시도해 주세요.',
                                earliest + self.quota_window - now)

    @staticmethod
    def public(job):
        value = {'job_id': job.id, 'status': job.state}
        if job.dataset is not None:
            value['dataset'] = dict(job.dataset)
        if job.state == 'succeeded':
            value['result'] = job.result
        elif job.state == 'failed':
            value.update(message=job.message, error_status=job.error_status)
        return value

    def submit(self, payload, owner):
        with self.lock:
            self._expire()
            if self.active is not None or len(self.items) >= self.capacity:
                raise Busy()
            self._check_quota(owner)
            copied = json.loads(json.dumps(payload, ensure_ascii=False))
            job = Job(id=str(uuid.uuid4()), owner_hash=owner, dataset=copied.get('dataset'))
            self.items[job.id] = job
            self.active = job.id
            accepted_at = self.clock()
            self.visitor_usage.setdefault(owner, deque()).append(accepted_at)
            self.global_usage.append(accepted_at)
            # API 입력 객체를 원본과 분리하고 한 작업만 실행합니다. 대기열은 만들지 않습니다.
            try:
                threading.Thread(target=self._run, args=(job.id, copied), daemon=True,
                                 name='rag-answer-job').start()
            except RuntimeError:
                del self.items[job.id]
                self.active = None
                self.visitor_usage[owner].pop()
                if not self.visitor_usage[owner]:
                    del self.visitor_usage[owner]
                self.global_usage.pop()
                raise Busy() from None
            return self.public(job)

    def _run(self, job_id, payload):
        try:
            with self.lock:
                owner = self.items[job_id].owner_hash
            result = self.backend.request('POST', '/web/answer' if payload.get('dataset') else '/answer',
                                          {**payload, 'owner': owner} if payload.get('dataset') else payload)
            if payload.get('dataset') and result.get('dataset') != payload['dataset']:
                raise BackendUnavailable(502, '웹 데이터 답변의 버전 확인에 실패했습니다.')
            state, message, status = 'succeeded', None, None
        except BackendUnavailable as error:
            result, state, message, status = None, 'failed', error.message, error.status_code
        except Exception:
            # 예외 원문에는 경로/질문/내부 정보가 포함될 수 있어 기록하거나 외부로 반환하지 않습니다.
            result, state, message, status = None, 'failed', '답변 처리 중 오류가 발생했습니다.', 502
        with self.lock:
            job = self.items.get(job_id)
            if job is not None and not job.invalidated:
                job.result, job.state, job.message, job.error_status = result, state, message, status
                job.finished_at = self.clock()
            self.active = None

    def invalidate_datasets(self, owner, *, keep=None, deleted=None):
        with self.lock:
            for job in self.items.values():
                if job.owner_hash == owner and job.dataset and job.dataset['id'] != keep and (deleted is None or job.dataset['id'] == deleted):
                    job.invalidated, job.result, job.state = True, None, 'failed'
                    job.message, job.error_status, job.finished_at = '웹 데이터 연결이 변경되거나 삭제되었습니다. 현재 데이터를 다시 연결해 주세요.', 404, self.clock()

    def get(self, job_id, owner):
        with self.lock:
            self._expire()
            job = self.items.get(job_id)
            if job is None or not hmac.compare_digest(job.owner_hash, owner):
                return None
            dataset = dict(job.dataset) if job.dataset and not job.invalidated else None
        if dataset:
            try:
                current = self.backend.request('POST', '/web/datasets/status', {'owner': owner, 'dataset_id': dataset['id']})
                if current.get('revision') != dataset['revision'] or current.get('status') != 'ready':
                    raise BackendUnavailable(409, '웹 데이터 연결이 변경되었습니다.')
            except BackendUnavailable as error:
                if error.status_code not in (404, 409):
                    raise
                self.invalidate_datasets(owner, deleted=dataset['id'])
        with self.lock:
            return self.public(job)


def visitor_owner(request):
    """Worker가 익명 HttpOnly 쿠키에서 덮어쓴 값만 받고 SHA-256으로 보관합니다."""
    values = request.headers.getlist('x-rag-visitor')
    if len(values) != 1 or not VISITOR_PATTERN.fullmatch(values[0]):
        return None
    return hashlib.sha256(values[0].encode('ascii')).hexdigest()


class BoundaryMiddleware:
    """라우트 매칭보다 먼저 모든 경로에 인증 및 실제 스트림 크기 제한을 적용합니다."""
    def __init__(self, app, token):
        self.app = app
        self.expected = ('Bearer ' + token).encode('utf8')

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            await self.app(scope, receive, send)
            return
        headers = scope.get('headers', [])
        limit = MAX_DATASET_BYTES if scope.get('method') == 'POST' and scope.get('path') == '/datasets' else MAX_BODY_BYTES
        auth = [value for key, value in headers if key.lower() == b'authorization']
        if len(auth) != 1 or not hmac.compare_digest(auth[0], self.expected):
            await JSONResponse({'message': '인증이 필요합니다.'}, 401,
                               headers={'WWW-Authenticate': 'Bearer'})(scope, receive, send)
            return
        lengths = [value for key, value in headers if key.lower() == b'content-length']
        if lengths:
            if len(lengths) != 1 or not lengths[0].isdigit():
                await JSONResponse({'message': '요청 형식이 올바르지 않습니다.'}, 400)(scope, receive, send)
                return
            # 매우 긴 숫자 헤더도 int 변환 제한/예외를 유발하지 않게 먼저 자릅니다.
            if len(lengths[0]) > 10 or int(lengths[0]) > limit:
                await JSONResponse({'message': '요청 본문이 너무 큽니다.'}, 413)(scope, receive, send)
                return
        chunks, size = [], 0
        while True:
            part = await receive()
            if part['type'] == 'http.disconnect':
                return
            if part['type'] != 'http.request':
                continue
            body = part.get('body', b'')
            size += len(body)
            if size > limit:
                await JSONResponse({'message': '요청 본문이 너무 큽니다.'}, 413)(scope, receive, send)
                return
            chunks.append(body)
            if not part.get('more_body', False):
                break
        if lengths and int(lengths[0]) != size:
            await JSONResponse({'message': '요청 본문 길이가 올바르지 않습니다.'}, 400)(scope, receive, send)
            return
        sent = False

        async def bounded_receive():
            nonlocal sent
            if not sent:
                sent = True
                return {'type': 'http.request', 'body': b''.join(chunks), 'more_body': False}
            return await receive()

        async def protected_send(message):
            if message['type'] == 'http.response.start':
                message['headers'] = list(message.get('headers', [])) + [
                    (b'cache-control', b'no-store'), (b'x-content-type-options', b'nosniff')]
            await send(message)

        await self.app(scope, bounded_receive, protected_send)


def create_app(token=None, backend=None, jobs=None):
    token = token if token is not None else os.environ.get('RAG_GATEWAY_TOKEN', '')
    if not isinstance(token, str) or len(token) < 32 or token != token.strip():
        raise RuntimeError('RAG_GATEWAY_TOKEN에 32자 이상의 비밀 값을 설정해야 합니다.')
    backend = backend or LocalBackend()
    jobs = jobs or Jobs(backend)
    app = FastAPI(title='RAG deployment gateway', docs_url=None, redoc_url=None,
                  openapi_url=None, debug=False)
    app.add_middleware(BoundaryMiddleware, token=token)
    app.state.jobs = jobs

    @app.exception_handler(BackendUnavailable)
    async def backend_error(request, error):
        return JSONResponse({'message': error.message}, error.status_code,
                            headers={'Retry-After': '5'} if error.status_code == 429 else {})

    def checked_owner(request):
        owner = visitor_owner(request)
        if owner is None:
            raise BackendUnavailable(400, '방문자 확인 정보가 올바르지 않습니다. 페이지를 새로고침해 주세요.')
        return owner

    def checked_dataset_id(value):
        try:
            if str(uuid.UUID(value)) != value:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise BackendUnavailable(404, '웹 데이터 연결을 찾을 수 없습니다.') from None
        return value

    def public_dataset(value, expected_id=None):
        if (not isinstance(value, dict) or value.get('status') not in ('indexing', 'ready', 'failed')
                or not isinstance(value.get('revision'), str) or not re.fullmatch(r'[0-9a-f]{64}', value['revision'])
                or type(value.get('row_count')) is not int or not 1 <= value['row_count'] <= 2000
                or type(value.get('chunk_count')) is not int or not 1 <= value['chunk_count'] <= 2048):
            raise BackendUnavailable(502, '웹 데이터 연결 상태를 확인하지 못했습니다.')
        identifier = checked_dataset_id(value.get('dataset_id'))
        if expected_id and identifier != expected_id:
            raise BackendUnavailable(502, '웹 데이터 연결 상태를 확인하지 못했습니다.')
        result = {key: value[key] for key in ('dataset_id', 'revision', 'status', 'row_count', 'chunk_count')}
        if value['status'] == 'failed':
            result['message'] = '웹 데이터 인덱싱에 실패했습니다. 모델 실행 상태와 데이터 크기를 확인해 주세요.'
        return result

    @app.post('/datasets', status_code=202)
    async def create_dataset(request: Request):
        owner = checked_owner(request)
        if request.headers.get('content-type', '').split(';', 1)[0].strip().lower() != 'application/json':
            raise BackendUnavailable(415, 'JSON 형식으로 요청해 주세요.')
        try:
            value = await request.json()
            if not isinstance(value, dict) or set(value) != {'schema_version', 'client_revision', 'meta', 'data'}:
                raise ValueError()
        except (ValueError, UnicodeError):
            raise BackendUnavailable(422, '웹 데이터 요청 형식을 확인해 주세요.') from None
        from starlette.concurrency import run_in_threadpool
        result = await run_in_threadpool(backend.request, 'POST', '/web/datasets', {**value, 'owner': owner})
        result = public_dataset(result)
        jobs.invalidate_datasets(owner, keep=result['dataset_id'])
        return JSONResponse(result, 202, headers={'Location': '/datasets/' + result['dataset_id']})

    @app.get('/datasets/{dataset_id}')
    def dataset_status(dataset_id: str, request: Request):
        owner = checked_owner(request)
        identifier = checked_dataset_id(dataset_id)
        return public_dataset(backend.request('POST', '/web/datasets/status', {'owner': owner, 'dataset_id': identifier}), identifier)

    @app.delete('/datasets/{dataset_id}')
    def delete_dataset(dataset_id: str, request: Request):
        owner = checked_owner(request)
        identifier = checked_dataset_id(dataset_id)
        value = backend.request('POST', '/web/datasets/delete', {'owner': owner, 'dataset_id': identifier})
        if value != {'deleted': True}:
            raise BackendUnavailable(502, '웹 데이터 연결 해제를 확인하지 못했습니다.')
        jobs.invalidate_datasets(owner, deleted=identifier)
        return {'deleted': True}

    @app.get('/health')
    def health():
        data = backend.request('GET', '/health')
        return {'status': 'ok' if data.get('status') == 'ok' else 'unavailable'}

    @app.get('/models')
    def models():
        data = backend.request('GET', '/models')
        available = data.get('models')
        if not isinstance(available, list):
            raise BackendUnavailable(502, '모델 목록을 확인하지 못했습니다.')
        allowed = {'qwen3:8b', 'gemma3:4b', 'llama3.1:8b'}
        return {'models': [{'model': item['model'], 'installed': item.get('installed') is True}
                           for item in available if isinstance(item, dict) and item.get('model') in allowed]}

    @app.post('/jobs', status_code=202)
    async def submit(request: Request):
        owner = visitor_owner(request)
        if owner is None:
            return JSONResponse({'message': '방문자 확인 정보가 올바르지 않습니다. 페이지를 새로고침해 주세요.'}, 400)
        if request.headers.get('content-type', '').split(';', 1)[0].strip().lower() != 'application/json':
            return JSONResponse({'message': 'JSON 형식으로 요청해 주세요.'}, 415)
        try:
            value = await request.json()
            if not isinstance(value, dict):
                raise ValueError('object required')
            payload = AnswerInput.model_validate(value).model_dump(exclude_none=True)
        except (ValueError, ValidationError):
            return JSONResponse({'message': '질문·모델·조회 조건의 형식이나 범위를 확인해 주세요.'}, 422)
        if payload.get('dataset'):
            current = backend.request('POST', '/web/datasets/status', {'owner': owner, 'dataset_id': payload['dataset']['id']})
            if current.get('status') != 'ready' or current.get('revision') != payload['dataset']['revision']:
                raise BackendUnavailable(409, '웹 데이터가 변경되었거나 준비되지 않았습니다. 현재 데이터를 다시 연결해 주세요.')
        try:
            result = jobs.submit(payload, owner)
        except Busy:
            return JSONResponse({'message': '다른 질문을 처리 중이거나 보관 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.'},
                                429, headers={'Retry-After': '5'})
        except QuotaExceeded as error:
            return JSONResponse({'message': error.message}, 429,
                                headers={'Retry-After': str(error.retry_after)})
        return JSONResponse(result, 202, headers={'Location': '/jobs/' + result['job_id']})

    @app.get('/jobs/{job_id}')
    def poll(job_id: str, request: Request):
        owner = visitor_owner(request)
        if owner is None:
            return JSONResponse({'message': '방문자 확인 정보가 올바르지 않습니다. 페이지를 새로고침해 주세요.'}, 400)
        try:
            valid = str(uuid.UUID(job_id)) == job_id
        except ValueError:
            valid = False
        result = jobs.get(job_id, owner) if valid else None
        if result is None:
            return JSONResponse({'message': '작업을 찾을 수 없거나 보관 시간이 지났습니다.'}, 404)
        return result

    return app
