"""브라우저/Java 백엔드가 호출할 HTTP API입니다."""
from functools import lru_cache
from typing import Literal
import json
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, Field, field_validator
from .service import RagService
from .prompting import build_prompt
from .generation import OllamaGenerator, GenerationError
from .web_corpus import (WebCorpusRegistry, WebCorpusError, MAX_UPLOAD_BYTES,
                         dataset_handle, owner_value, invalid)

app = FastAPI(title='구매관리 RAG 백엔드', version='1.3.0',
              description='로컬 테스트용. 정확 조회는 원본 DB, 민원 내용은 BGE-M3/Chroma로 검색합니다. /answer에서 생성 모델을 선택하면 Ollama로 답변과 출처를 반환합니다. 근거 부족·모호한 질문은 모델 호출 전에 처리합니다.')
app.add_middleware(TrustedHostMiddleware, allowed_hosts=['127.0.0.1','localhost','testserver'])

@lru_cache
def service():
    return RagService()

@lru_cache
def generator():
    return OllamaGenerator()


@lru_cache
def web_corpora():
    def encode(texts):
        shared = service()
        # 기존 DB 구축/검색과 같은 BGE 인스턴스 및 잠금을 사용합니다.
        with shared.lock:
            return shared.encode(texts)
    registry = WebCorpusRegistry(encode)
    registry.start_cleanup(interval=60)
    return registry


@app.exception_handler(WebCorpusError)
async def web_error(_request, error):
    return JSONResponse({'message': error.message}, error.status,
                        headers={'cache-control': 'no-store'})


async def web_body(request, limit=8192):
    if request.headers.get('content-type', '').split(';', 1)[0].strip().lower() != 'application/json':
        raise WebCorpusError(415, 'JSON 형식으로 요청해 주세요.')
    size, chunks = 0, []
    async for part in request.stream():
        size += len(part)
        if size > limit:
            raise WebCorpusError(413, '웹 데이터 전송 한도를 넘었습니다. 데이터 범위를 줄여 주세요.')
        chunks.append(part)
    try:
        value = json.loads(b''.join(chunks))
    except (ValueError, UnicodeError):
        invalid()
    if not isinstance(value, dict):
        invalid()
    return value


@app.post('/web/datasets', status_code=202, summary='웹 현재 스냅샷을 메모리에 연결')
async def create_web_dataset(request: Request):
    value = await web_body(request, MAX_UPLOAD_BYTES + 256)
    owner = owner_value(value.pop('owner', None))
    return web_corpora().create(value, owner)


@app.post('/web/datasets/status', summary='웹 메모리 인덱싱 상태')
async def web_dataset_status(request: Request):
    value = await web_body(request)
    if set(value) != {'owner', 'dataset_id'} or not isinstance(value['dataset_id'], str):
        invalid()
    return web_corpora().status(owner_value(value['owner']), value['dataset_id'])


@app.post('/web/datasets/delete', summary='웹 메모리 데이터 삭제')
async def delete_web_dataset(request: Request):
    value = await web_body(request)
    if set(value) != {'owner', 'dataset_id'} or not isinstance(value['dataset_id'], str):
        invalid()
    return web_corpora().delete(owner_value(value['owner']), value['dataset_id'])


@app.post('/web/answer', summary='웹 현재 스냅샷 근거로 답변')
async def web_answer(request: Request):
    value = await web_body(request)
    if set(value) - {'question', 'model', 'top_k', 'dataset', 'owner'} or not {'question', 'model', 'dataset', 'owner'} <= set(value):
        invalid()
    if value['model'] not in ('qwen3:8b', 'gemma3:4b', 'llama3.1:8b'):
        invalid()
    owner = owner_value(value['owner'])
    handle = dataset_handle(value['dataset'])
    # 긴 모델 생성은 event loop를 막지 않아 삭제·상태 요청을 동시에 처리할 수 있습니다.
    from starlette.concurrency import run_in_threadpool
    return await run_in_threadpool(lambda: execute(lambda: web_corpora().answer(
        owner, handle, value['question'], value['model'], value.get('top_k', 3), generator())))

class SearchRequest(BaseModel):
    question: str = Field(min_length=1, max_length=1000, examples=['베어링 완충 포장이 부족하다는 민원을 찾아줘'])
    top_k: int = Field(default=3, ge=1, le=10)
    order_id: int | None = Field(default=None, gt=0, description='발주 번호를 정확히 지정할 때 사용')
    supplier_id: int | None = Field(default=None, gt=0)
    part_id: int | None = Field(default=None, gt=0)
    document_type: Literal['supplier','part','supplier_part','order','complaint'] | None = None

    @field_validator('question')
    @classmethod
    def not_blank(cls, value):
        value = value.strip()
        if not value:
            raise ValueError('질문을 입력하세요.')
        return value

class AnswerRequest(SearchRequest):
    model: Literal['qwen3:8b', 'gemma3:4b', 'llama3.1:8b'] = Field(
        description='사용할 생성 모델을 직접 선택하세요. 기본 모델은 지정하지 않습니다.',
        examples=['gemma3:4b'])

def execute(fn):
    try:
        return fn()
    except GenerationError as error:
        raise HTTPException(status_code=error.status_code,
                            detail={'message':str(error), 'model_called':error.model_called}) from error
    except LookupError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

@app.get('/health', summary='서버 실행 여부 확인')
def health():
    return {'status': 'ok'}

@app.get('/status', summary='저장된 벡터 개수와 원본 변경 여부')
def status():
    return execute(lambda: service().status())

@app.post('/index', summary='DB 조회부터 벡터 DB 저장까지 실행')
def index():
    return execute(lambda: service().index())

@app.post('/search', summary='조건 검증 후 DB 정확 조회 또는 벡터 검색')
def search(request: SearchRequest):
    filters = request.model_dump(exclude={'question','top_k'}, exclude_none=True)
    return execute(lambda: service().search(request.question, request.top_k, filters))

@app.post('/prepare-prompt', summary='질문·검색 근거·출처 통합 (답변 생성 없음)')
def prepare_prompt(request: SearchRequest):
    filters = request.model_dump(exclude={'question','top_k'}, exclude_none=True)
    return execute(lambda: build_prompt(service().search(request.question, request.top_k, filters)))

@app.get('/models', summary='선택 가능한 생성 모델과 설치 여부')
def models():
    return execute(lambda: generator().models())

@app.post('/answer', summary='검색 근거로 Ollama 답변 생성 및 출처 반환')
def answer(request: AnswerRequest):
    filters = request.model_dump(exclude={'question','top_k','model'}, exclude_none=True)
    return execute(lambda: generator().answer(
        service().search(request.question, request.top_k, filters), request.model))
