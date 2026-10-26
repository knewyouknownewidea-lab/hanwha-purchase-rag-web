"""단가 인상 협상: 코드가 계산한 사실만 LangChain 체인(Prompt → ChatOllama)으로 전달해
'협상 논리 보고서'와 '공문 이메일 초안'을 작성합니다.

1. 판단: 요구 인상률·원자재 인상률·차이·판정은 이 모듈이 원래 값으로 다시 계산합니다(브라우저 계산값을 믿지 않음).
2. 합성: 계산 결과를 하나의 [사실] 블록으로 묶어 프롬프트에 넣습니다.
3. 생성: LLM은 문장만 씁니다. 사실에 없는 퍼센트가 나오면 '검토 필요'로 표시합니다.
"""
import json
import re
import threading
from statistics import mean
from typing import Literal

from langchain_core.prompts import ChatPromptTemplate
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictFloat, StrictInt, StrictStr

from .generation import GenerationError, MODELS, OLLAMA_URL, OPTIONS

Number = StrictInt | StrictFloat
MAX_PROMPT_BYTES = 6144
VERDICT_LABEL = {'excessive': '과도한 인상 요구 가능성', 'within': '원자재 인상률 범위 안',
                 'insufficient_data': '원자재 자료 부족으로 판정 보류'}


class Material(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: StrictStr = Field(min_length=1, max_length=20)
    change_pct: Number | None = Field(default=None, ge=-100, le=1000)


class NegotiationFacts(BaseModel):
    """브라우저가 보내는 원래 값. 파생 값(인상률·차이·판정)은 받지 않습니다."""
    model_config = ConfigDict(extra='forbid')
    supplier: StrictStr = Field(min_length=1, max_length=60)
    item: StrictStr = Field(min_length=1, max_length=60)
    currency: StrictStr = Field(pattern=r'^[A-Z]{3}$')
    unit: StrictStr = Field(min_length=1, max_length=10)
    source: Literal['quote', 'contract']
    prev_price: Number = Field(gt=0, le=1e12)
    requested_price: Number = Field(gt=0, le=1e12)
    period: StrictStr = Field(min_length=1, max_length=40)
    materials: list[Material] = Field(max_length=6)
    threshold_pp: Number = Field(ge=0, le=50)
    sample: StrictBool


def analyze(facts: NegotiationFacts):
    """요구 인상률 vs 주요 소재 평균 인상률(단순 평균). web src/lib/negotiation.ts와 같은 규칙입니다."""
    requested = round((facts.requested_price / facts.prev_price - 1) * 100, 1)
    known = [m.change_pct for m in facts.materials if m.change_pct is not None]
    material = round(mean(known), 1) if known else None
    gap = round(requested - material, 1) if material is not None else None
    verdict = ('insufficient_data' if gap is None else
               'excessive' if gap > facts.threshold_pp else 'within')
    return {'requested_change_pct': requested, 'material_change_pct': material,
            'gap_pp': gap, 'verdict': verdict}


SYSTEM = """너는 한화엔진 구매팀의 협상 문서 작성 보조다. [사실]에 있는 값만 사용한다.
공통 규칙
- 새 숫자·업체명·날짜·근거를 만들지 않는다. 퍼센트는 [사실]의 값을 소수 첫째 자리까지 그대로 쓰고, 차이는 %p로 쓴다.
- 날짜·기한·담당자 이름은 쓰지 말고 필요한 곳에 '[회신 기한]', '[담당자]'처럼 빈칸으로 남긴다.
- 원자재가 단가에서 차지하는 비중 자료는 없다. 이 점을 밝힌다.
보고서(구매팀 내부용)
- 데이터가 SAMPLE이면 첫 줄에 '시연용 가상 데이터 기준'이라고 쓴다.
- 요구 인상률과 소재 평균 인상률을 대조하고 차이·판정 기준·판정을 그대로 옮긴다. 판정은 바꾸지 않는다.
- 협상 논점을 3가지 이내로, 공급사에 요청할 근거 자료를 적는다.
- 업체 선정·단가 확정은 담당자가 최종 판단한다고 쓴다.
이메일(공급사 담당자에게 보내는 공문)
- 정중하게 쓰고 제목 한 줄, 본문, 요청 사항, 회신 요청 순서로 쓴다.
- 내부 판정('과도' 등)과 판정 기준은 쓰지 않는다. 요구 인상률과 원자재 시세 흐름의 차이에 대한 원가 근거를 요청한다.
출력은 아래 두 머리글만 그대로 쓰고 그 밖의 머리글이나 안내 문장은 옮겨 쓰지 않는다.
[협상 논리 보고서]
[공문 이메일 초안]"""
PROMPT = ChatPromptTemplate.from_messages([('system', SYSTEM), ('human', '[사실]\n{facts}')])


def fact_block(facts: NegotiationFacts, result):
    value = {
        '협력사': facts.supplier, '품목': facts.item,
        '요구 단가 출처': '공급사 견적서' if facts.source == 'quote' else '계약 단가(직전 → 최근 계약)',
        '기존 단가': f'{facts.prev_price:,} {facts.currency}/{facts.unit}',
        '요구 단가': f'{facts.requested_price:,} {facts.currency}/{facts.unit}',
        '요구 인상률(%)': result['requested_change_pct'],
        '원자재 비교 기간': facts.period,
        '주요 소재별 인상률(%)': {m.name: m.change_pct if m.change_pct is not None else '자료 없음' for m in facts.materials},
        '주요 소재 평균 인상률(%, 단순 평균)': result['material_change_pct'] if result['material_change_pct'] is not None else '자료 없음',
        '차이(%p) = 요구 인상률 - 소재 평균 인상률': result['gap_pp'] if result['gap_pp'] is not None else '계산 불가',
        '과도 판정 기준(%p, 담당자 설정)': facts.threshold_pp,
        '판정': VERDICT_LABEL[result['verdict']],
        '데이터': 'SAMPLE · 시연용 가상 데이터' if facts.sample else '업로드 데이터',
    }
    return json.dumps(value, ensure_ascii=False, indent=1)


def allowed_numbers(facts: NegotiationFacts, result):
    values = [result['requested_change_pct'], result['material_change_pct'], result['gap_pp'], facts.threshold_pp]
    values += [m.change_pct for m in facts.materials]
    out = set()
    for v in values:
        if v is None:
            continue
        for x in (v, abs(v)):
            out.update({f'{x:.1f}', f'{x:g}', f'{round(x)}'})
    return out


def unknown_percents(text, allowed):
    # 숫자 뒤 %·%p만 대조합니다. 단가 등 다른 숫자는 검사하지 않습니다(사실 블록에 있는 값을 그대로 쓰도록 프롬프트로 제한).
    found = re.findall(r'(\d+(?:\.\d+)?)\s*%', text)
    return sorted({n for n in found if n not in allowed and f'{float(n):g}' not in allowed})


def invented_dates(text, facts: NegotiationFacts):
    # 사실 블록에 없는 날짜(연·월·일 표기)를 찾습니다. 비교 기간에 있는 'YYYY-MM'은 허용합니다.
    found = re.findall(r'\d{4}\s*년(?:\s*\d{1,2}\s*월)?(?:\s*\d{1,2}\s*일)?|\d{4}-\d{2}(?:-\d{2})?|\d{1,2}\s*월\s*\d{1,2}\s*일', text)
    return sorted({d for d in found if d not in facts.period})


def split_sections(text):
    m = re.search(r'\[협상 논리 보고서\](.*?)\[공문 이메일 초안\](.*)', text, re.S)
    return (m[1].strip(), m[2].strip()) if m else (None, None)


class NegotiationWriter:
    def __init__(self, llm_factory=None):
        self.lock = threading.Lock()
        self.llm_factory = llm_factory or self._ollama

    @staticmethod
    def _ollama(model):
        from langchain_ollama import ChatOllama
        return ChatOllama(model=model, base_url=OLLAMA_URL, reasoning=False if model.startswith('qwen3') else None,
                          temperature=OPTIONS['temperature'], seed=OPTIONS['seed'], num_ctx=OPTIONS['num_ctx'],
                          num_predict=OPTIONS['num_predict'], num_gpu=OPTIONS['num_gpu'],
                          num_thread=OPTIONS['num_thread'], keep_alive=0, client_kwargs={'timeout': 600, 'trust_env': False})

    def write(self, question, facts: NegotiationFacts, model):
        if model not in MODELS:
            raise ValueError('지원하는 생성 모델을 선택하세요.')
        result = analyze(facts)
        block = fact_block(facts, result)
        out = {'question': question, 'generation_model': model, 'model_called': False, 'sources': [],
               'retrieval_method': 'negotiation_facts', 'citation_check': 'not_applicable',
               'facts': {**result, 'threshold_pp': facts.threshold_pp, 'source': facts.source}}
        messages = PROMPT.format_messages(facts=block)
        if sum(len(m.content.encode('utf8')) for m in messages) > MAX_PROMPT_BYTES:
            return {**out, 'status': 'context_limit_exceeded', 'answer': None,
                    'message': '입력 사실이 너무 깁니다. 소재 수를 줄여 다시 시도해 주세요.'}
        chain = PROMPT | self.llm_factory(model)
        with self.lock:  # 생성 모델은 이 PC에서 한 요청씩 실행합니다.
            try:
                reply = chain.invoke({'facts': block})
            except GenerationError:
                raise
            except Exception as error:  # 원문 예외에는 내부 주소·경로가 섞일 수 있어 그대로 반환하지 않습니다.
                raise GenerationError(503, 'Ollama에 연결하지 못했거나 모델 실행에 실패했습니다. Ollama 실행 여부를 확인해 주세요.', None) from error
        meta = getattr(reply, 'response_metadata', {}) or {}
        text = reply.content if isinstance(reply.content, str) else ''
        if meta.get('model') != model:
            raise GenerationError(502, '요청한 모델과 응답 모델이 일치하지 않습니다.', True)
        if meta.get('done') is not True or meta.get('done_reason') != 'stop' or not text.strip():
            raise GenerationError(502, '모델 답변이 비어 있거나 생성이 완료되지 않았습니다.', True)
        count = meta.get('prompt_eval_count')
        if type(count) is not int or count >= OPTIONS['num_ctx'] - OPTIONS['num_predict']:
            raise GenerationError(502, '모델 입력 한도에 도달해 사실이 모두 전달됐는지 확인할 수 없습니다.', True)
        report, email = split_sections(text.strip())
        if not report or not email:
            return {**out, 'model_called': True, 'status': 'invalid_generation', 'answer': None,
                    'message': '보고서와 이메일 형식을 확인하지 못했습니다. 다시 시도해 주세요.'}
        extra = [n + '%' for n in unknown_percents(report + '\n' + email, allowed_numbers(facts, result))]
        extra += invented_dates(report + '\n' + email, facts)
        if re.search(r'과도|판정', email):  # 공급사에 보내는 공문에 내부 판정을 그대로 쓰지 않게 합니다.
            extra.append("이메일의 내부 판정 표현('과도'·'판정')")
        status = 'needs_review' if extra else 'drafted'
        note = (f'확인할 부분이 있습니다: {", ".join(extra)}. 담당자가 고친 뒤 사용해 주세요.' if extra
                else '퍼센트 수치가 계산값과 일치하고 지어낸 날짜가 없음을 확인했습니다. 문장의 사실 여부를 자동 검증한 것은 아닙니다.')
        return {**out, 'model_called': True, 'status': status, 'report': report, 'email': email, 'note': note,
                'answer': f'{facts.supplier} {facts.item}: {VERDICT_LABEL[result["verdict"]]}. 협상 논리 보고서와 공문 이메일 초안을 작성했습니다.',
                'message': '코드가 계산한 사실로 보고서와 이메일 초안을 작성했습니다.'}
