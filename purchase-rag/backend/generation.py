"""검증된 검색 근거를 로컬 Ollama에 전달하고 답변과 출처를 반환합니다."""
import re
import threading
import httpx
from .prompting import build_prompt, NO_EVIDENCE

MODELS = ('qwen3:8b', 'gemma3:4b', 'llama3.1:8b')
OLLAMA_URL = 'http://127.0.0.1:11434'
OPTIONS = {'temperature': 0, 'seed': 42, 'num_ctx': 8192,
           'num_predict': 1024, 'num_gpu': 0, 'num_thread': 4}
# UTF-8 바이트 수로 보수적으로 제한합니다. 토큰 수의 정확한 계산은 아닙니다.
# 채팅 템플릿과 출력 공간을 확보하며 긴 근거를 임의로 잘라서 보내지 않습니다.
MAX_PROMPT_BYTES = 6144


class GenerationError(RuntimeError):
    def __init__(self, status_code, message, model_called=False):
        super().__init__(message)
        self.status_code = status_code
        self.model_called = model_called


class OllamaGenerator:
    def __init__(self):
        self.lock = threading.Lock()

    def _request(self, method, path, payload=None, generation=False):
        try:
            with httpx.Client(base_url=OLLAMA_URL, trust_env=False,
                              timeout=httpx.Timeout(600 if generation else 5, connect=3)) as client:
                response = client.request(method, path, json=payload)
            if response.status_code == 404:
                raise GenerationError(503, '선택한 모델이 설치되어 있는지 확인해 주세요.', generation)
            if response.is_error:
                raise GenerationError(502, 'Ollama에서 모델을 실행하지 못했습니다. 서버 로그를 확인해 주세요.', generation)
            data = response.json()
            if not isinstance(data, dict) or data.get('error'):
                raise GenerationError(502, 'Ollama가 올바른 응답을 반환하지 않았습니다.', generation)
            return data
        except GenerationError:
            raise
        except httpx.TimeoutException as error:
            raise GenerationError(504, '모델 응답 시간이 초과되었습니다. 다시 시도해 주세요.', None if generation else False) from error
        except httpx.RequestError as error:
            raise GenerationError(503, 'Ollama에 연결할 수 없습니다. Ollama 실행 여부를 확인해 주세요.', None if generation else False) from error
        except ValueError as error:
            raise GenerationError(502, 'Ollama 응답을 읽을 수 없습니다.', generation) from error

    def models(self):
        data = self._request('GET', '/api/tags')
        entries = data.get('models')
        if not isinstance(entries, list):
            raise GenerationError(502, 'Ollama의 설치 모델 목록을 읽을 수 없습니다.')
        installed = {m.get('name'): m for m in entries if isinstance(m, dict)}
        return {'models': [{'model': model, 'installed': model in installed,
                            'digest': installed.get(model, {}).get('digest')}
                           for model in MODELS]}

    def answer(self, search_result, model):
        if model not in MODELS:
            raise ValueError('지원하는 생성 모델을 선택하세요.')
        prepared = build_prompt(search_result)
        result = {'question': prepared['question'], 'status': prepared['status'],
                  'answer': None, 'message': prepared['message'],
                  'generation_model': model, 'model_called': False,
                  'retrieval_method': prepared['retrieval_method'],
                  'sources': [], 'citation_check': 'not_applicable'}
        if not prepared['ready_for_generation']:
            result['answer'] = prepared['message']
            return result
        if len(prepared['prompt'].encode('utf8')) > MAX_PROMPT_BYTES:
            result.update(status='context_limit_exceeded',
                          message='검색 근거가 입력 한도를 넘었습니다. 질문이나 검색 범위를 좁혀 주세요.')
            return result

        # 원본 DB 검색 잠금과 분리합니다. 생성 모델은 이 PC에서 한 요청씩 실행합니다.
        with self.lock:
            installed = self.models()['models']
            identity = next(m for m in installed if m['model'] == model)
            if not identity['installed']:
                raise GenerationError(503, '선택한 모델이 설치되어 있지 않습니다.')
            payload = {'model': model, 'messages': [{'role': 'user', 'content': prepared['prompt']}],
                       'options': OPTIONS, 'stream': False, 'keep_alive': 0}
            if model.startswith('qwen3'):
                payload['think'] = False
            response = self._request('POST', '/api/chat', payload, generation=True)

        message = response.get('message')
        text = message.get('content') if isinstance(message, dict) else None
        if response.get('model') != model:
            raise GenerationError(502, '요청한 모델과 응답 모델이 일치하지 않습니다.', True)
        if (response.get('done') is not True or response.get('done_reason') != 'stop'
                or not isinstance(text, str) or not text.strip()):
            raise GenerationError(502, '모델 답변이 비어 있거나 생성이 완료되지 않았습니다.', True)
        input_count = response.get('prompt_eval_count')
        if type(input_count) is not int or input_count < 0:
            raise GenerationError(502, '모델의 입력 길이 정보를 확인할 수 없습니다.', True)
        if input_count >= OPTIONS['num_ctx'] - OPTIONS['num_predict']:
            raise GenerationError(502, '모델 입력 한도에 도달해 근거가 모두 전달됐는지 확인할 수 없습니다.', True)

        text = text.strip()
        result.update(model_called=True, model_digest=identity['digest'],
                      prompt_eval_count=response.get('prompt_eval_count'),
                      eval_count=response.get('eval_count'))
        without_citations = re.sub(r'\[E\d+\]', '', text).strip()
        if without_citations == NO_EVIDENCE:
            result.update(status='insufficient_evidence', answer=NO_EVIDENCE, message=NO_EVIDENCE)
            return result
        labels = set(re.findall(r'\[(E\d+)\]', text))
        source_map = {s['evidence_id']: s for s in prepared['sources']}
        if not labels or not labels.issubset(source_map):
            result.update(status='invalid_generation', citation_check='failed',
                          message='답변의 출처 표기를 확인하지 못했습니다. 질문을 구체화해서 다시 시도해 주세요.')
            return result
        result.update(status='answered', answer=text,
                      message='검색 근거로 답변을 생성했습니다.',
                      citation_check='valid_ids_only',
                      sources=[s for s in prepared['sources'] if s['evidence_id'] in labels],
                      note='출처 번호의 존재를 확인했습니다. 문장별 사실 정확성을 자동 검증한 것은 아닙니다.')
        return result
