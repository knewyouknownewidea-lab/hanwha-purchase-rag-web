"""두 공식 지표와 실제 답변을 함께 보여주는 비교 보고서입니다."""
import sys
from pathlib import Path

# Allow both Run Python File and python -m from the project folder.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from project_paths import WORK_DIR, DATABASE, EVALUATIONS_DIR, REPORTS_DIR

import html
import json
import re
from evaluations.Ragas_평가준비.generate_answers import ROOT, save

DEST=ROOT.parent/'Ragas_충실도_관련성'
esc=html.escape

def main():
    summaries={stage:json.loads((DEST/stage/'summary.json').read_text(encoding='utf8')) for stage in ['baseline','tuned']}
    plan=json.loads((DEST/'tuning_plan.json').read_text(encoding='utf8'))
    table=[];detail=[];checks=[];paired=[];paired_rows=[]
    for model in plan['generators']:
        a=next(r for r in summaries['baseline']['models'] if r['model']==model)
        b=next(r for r in summaries['tuned']['models'] if r['model']==model)
        cells=[]
        for metric in ['faithfulness','answer_relevancy']:
            for row in [a,b]:
                score=row['metrics'][metric]
                value=f"{score['mean']:.3f}" if score['mean'] is not None else '계산 불가'
                cells.append(f"<td>{value}<small>유효 {score['valid_count']}/{score['total']}</small></td>")
        table.append(f"<tr><th>{esc(model)}</th>{''.join(cells)}</tr>")
        paired_metrics={}
        for name in ['faithfulness','answer_relevancy']:
            pairs=[]
            for question in plan['rows']:
                identifier=question['id']
                left=json.loads((DEST/'baseline'/model.replace(':','_')/(identifier+'.json')).read_text(encoding='utf8'))
                right=json.loads((DEST/'tuned'/model.replace(':','_')/(identifier+'.json')).read_text(encoding='utf8'))
                if name in left['scores'] and name in right['scores']:
                    pairs.append((left['scores'][name],right['scores'][name]))
            p0=sum(x[0] for x in pairs)/len(pairs) if pairs else None
            p1=sum(x[1] for x in pairs)/len(pairs) if pairs else None
            delta=p1-p0 if pairs else None
            paired_metrics[name]={'baseline_mean':p0,'tuned_mean':p1,'delta':delta,'n':len(pairs)}
            values=[f'{p0:.3f}',f'{p1:.3f}',f'{delta:+.3f}'] if pairs else ['-','-','-']
            paired_rows.append(f"<tr><td>{esc(model)}</td><td>{name}</td><td>{values[0]}</td><td>{values[1]}</td><td>{values[2]}</td><td>{len(pairs)}</td></tr>")
        paired.append({'model':model,'metrics':paired_metrics})
        for question in plan['rows']:
            identifier=question['id'];answers=[]
            for stage in ['baseline','tuned']:
                folder=ROOT/model.replace(':','_') if stage=='baseline' else DEST/'tuned_answers'/model.replace(':','_')
                answer=json.loads((folder/(identifier+'.json')).read_text(encoding='utf8'))
                score=json.loads((DEST/stage/model.replace(':','_')/(identifier+'.json')).read_text(encoding='utf8'))
                labels=set(re.findall(r'\[(E\d+)\]',answer['response']))
                available={s['evidence_id'] for s in answer['sources']}
                flags=[]
                if not labels:flags.append('출처 표기 없음')
                if labels-available:flags.append('없는 출처 번호')
                if '제공된 문서에서 관련 정보를 찾을 수 없습니다.' in answer['response']:flags.append('답변 가능한 문항에 정보 없음 응답')
                if 4<=int(identifier[1:])<=12 and re.search(r'\d[\d,]*\s*원',answer['response']):flags.append('근거에 없는 통화 단위 추가')
                if answer.get('truncated'):flags.append('출력 길이 제한 도달')
                checks.append({'stage':stage,'model':model,'id':identifier,'flags':flags})
                scores=' · '.join(f"{name}: {value:.3f}" for name,value in score['scores'].items())
                error=' · '.join(f'{name}: {value}' for name,value in score['errors'].items())
                answers.append('<td>'+esc(answer['response'])+'<small>'+esc(scores)+'</small><strong>'+esc(' / '.join(flags))+'</strong><small>'+esc(error)+'</small></td>')
            detail.append(f"<tr><td>{esc(model)} / {identifier}<small>{esc(question['question'])}</small></td>{''.join(answers)}</tr>")
    save(DEST/'supplementary_checks.json',checks)
    save(DEST/'paired_comparison.json',{'models':paired,'note':'P0와 P1 양쪽 모두 점수가 있는 같은 문항만 비교. 독립 평가가 아님.'})
    page='''<!doctype html><html lang="ko"><meta charset="utf-8"><title>Ragas 충실도·답변 관련성 및 프롬프트 튜닝</title><style>body{font-family:Malgun Gothic,sans-serif;max-width:1250px;margin:38px auto;padding:0 24px;line-height:1.7;color:#173047}h1{font-size:27px}h2{font-size:21px;margin-top:30px}table{border-collapse:collapse;width:100%;margin:16px 0}th,td{border:1px solid #d5e1ea;padding:12px;text-align:left;vertical-align:top;white-space:pre-wrap}th{background:#edf4f7}small{display:block;color:#53677a;margin-top:7px}.note{padding:16px;background:#fff1d8;border-left:5px solid #b77920}pre{white-space:pre-wrap;background:#eef4f7;padding:16px}strong{color:#a04c1c}</style>
<h1>Ragas 충실도·답변 관련성 — 프롬프트 보완 비교</h1>
<p class="note">기존 개발 질문 30개×3모델의 예비 평가입니다. 이미 확인한 오류를 바탕으로 튜닝했으므로 독립 최종 성능 검증이 아닙니다. 운영 프롬프트는 이번 비교 중에 변경하지 않았습니다.</p>
<h2>두 지표의 의미</h2><p>근거 충실성(Faithfulness): 답변의 주장 중 검색 근거가 뒷받침하는 비율입니다. 답변 관련성(AnswerRelevancy): 답변에서 재구성한 질문과 원 질문의 임베딩 유사도로 계산하며, 사실 정확도와는 다릅니다. 둘 다 참고 정답 문장을 입력으로 사용하지 않습니다.</p>
<h2>같은 조건에서 프롬프트만 보완</h2><p>P0: 기존 사용자 템플릿. P1: 대상·요청 항목 명시, 관련 민원 식별, 날짜·단위 추정 방지, 문장별 출처 표시를 추가한 후보입니다. 모델·질문·검색 근거·양자화·생성 설정·채점 설정은 동일하게 유지했습니다.</p>
<table><tr><th rowspan="2">모델</th><th colspan="2">근거 충실성</th><th colspan="2">답변 관련성</th></tr><tr><th>P0 기본 규칙</th><th>P1 보완 규칙</th><th>P0 기본 규칙</th><th>P1 보완 규칙</th></tr>'''+''.join(table)+'''</table>
<p>높을수록 좋습니다. 오류·NaN은 0점으로 바꾸지 않고 유효 문항 수를 표시했습니다. 주장 없는 답변은 충실성 점수가 정의되지 않을 수 있으므로 평균과 함께 실제 답변 및 정보 없음 응답을 확인해야 합니다. 임의의 종합 점수나 합격선을 만들지 않았습니다.</p>
<h2>평가 조건과 해석 범위</h2><p>Ollama 0.40.11 · Ragas 0.4.3 공식 metrics.collections · 공통 채점 모델 Qwen3 14B(Q4_K_M), GPU 20레이어+나머지 CPU · 채점 temperature 0, seed 42, 입력 8192, 출력 4096 · 생성 모델 CPU 4스레드, temperature 0, seed 42, 입력 8192, 출력 1024 · 관련성 임베딩 BGE-M3 고정 revision.</p>
<p>채점 모델은 Qwen 계열이므로 같은 계열에 대한 편향이 있을 수 있습니다. 관련성 strictness=3이지만 고정 seed와 동일 요청 캐시로 같은 재구성 질문이 반복될 수 있습니다. 긴 답변이 관련성 점수만 올렸는지, 근거 밖 내용이 늘었는지 실제 문항도 대조해야 합니다. 근거 부족·모호한 질문 32개는 백엔드 검사로, 생성 모델 점수에 합산하지 않습니다.</p>
<h2>P1에 추가한 규칙</h2><pre>'''+esc(plan['rules'])+'''</pre>
<h2>실제 답변 및 문항별 점수</h2><p>출처 번호 검사는 해당 번호의 존재만 확인합니다. 문장별 의미·날짜 해석의 정확성을 보장하지 않습니다. 초기 관찰 사례(Qwen의 날짜 추정, 불필요한 정보 없음 응답 등)는 원문과 함께 검토해야 합니다.</p><table><tr><th>모델·질문</th><th>P0 실제 답변</th><th>P1 실제 답변</th></tr>'''+''.join(detail)+'</table></html>'
    context=json.loads((DEST/'context_relevance/summary.json').read_text(encoding='utf8'))
    context_value=f"{context['mean']:.3f}" if context['mean'] is not None else '계산 불가'
    shared=f"<h2>근거 관련성 - 모든 모델과 P0/P1 공통</h2><p>Ragas ContextRelevance: <b>{context_value}</b> (유효 {context['valid_count']}/{context['total']}). 질문·검색 근거를 바꾸지 않았으므로 공통 점수입니다. 서로 다른 두 관점의 채점 프롬프트를 같은 Qwen3 14B에 적용했습니다.</p>"
    pair_table='<h2>같은 유효 문항끼리 비교한 변화</h2><p>누락·오류 문항이 달라서 평균이 바뀌는 영향을 줄이기 위해 양쪽 모두 점수가 있는 같은 질문만 비교했습니다. 추가로 유효해진 답변의 변화는 위 유효 수와 실제 답변에서 확인합니다.</p><table><tr><th>모델</th><th>지표</th><th>P0</th><th>P1</th><th>변화</th><th>공통 문항 수</th></tr>'+''.join(paired_rows)+'</table>'
    page=page.replace('Ragas 충실도·답변 관련성 — 프롬프트 보완 비교','RAG Triad 관점의 Ragas 평가 - 프롬프트 보완 비교')
    page=page.replace('<h2>같은 조건에서 프롬프트만 보완</h2>',shared+'<h2>같은 조건에서 프롬프트만 보완</h2>')
    page=page.replace('<h2>평가 조건과 해석 범위</h2>',pair_table+'<h2>평가 조건과 해석 범위</h2>')
    page=page.replace('<h2>두 지표의 의미</h2>','<p>RAG Triad는 평가 관점이며 도구 이름이 아닙니다. 근거 관련성·근거 충실성·답변 관련성의 세 축을 Ragas 지표로 평가했습니다. TruLens 원본 채점 구현과 점수가 동일하다는 뜻은 아닙니다.</p><h2>답변 평가 두 지표의 의미</h2>')
    page=page.replace('출처 번호 검사는 해당 번호의 존재만 확인합니다.','보조 검출은 문자열 규칙에 따른 표시로 모든 오류를 판정하지 않습니다. 출처 번호 검사는 해당 번호의 존재만 확인합니다.')
    report_dir=REPORTS_DIR/'Ragas_충실도_관련성'
    report_dir.mkdir(parents=True,exist_ok=True)
    (report_dir/'충실도_답변관련성_튜닝보고서.html').write_text(page,encoding='utf8')
    print('Two-metric tuning report saved.',flush=True)

if __name__=='__main__':main()
