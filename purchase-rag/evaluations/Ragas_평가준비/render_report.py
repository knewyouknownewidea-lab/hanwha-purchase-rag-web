"""완료된 실제 생성/채점 파일만 읽어 결과 보고서를 작성합니다."""
import sys
from pathlib import Path

# Allow both Run Python File and python -m from the project folder.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from project_paths import WORK_DIR, DATABASE, EVALUATIONS_DIR, REPORTS_DIR

import html
import json
import re

ROOT=Path(__file__).resolve().parent
esc=html.escape
plan=json.loads((ROOT/'평가계획_검토용.json').read_text(encoding='utf8'))
summary=json.loads((ROOT/'ragas_summary.json').read_text(encoding='utf8'))
backend=json.loads((ROOT/'backend_checks.json').read_text(encoding='utf8'))
manifest=json.loads((ROOT/'evaluation_manifest.json').read_text(encoding='utf8'))
names={'faithfulness':'근거 충실성','factual_correctness':'사실 정확성(F1)','answer_relevancy':'질문 관련성'}
summary_rows=[]
details=[]
audit=[]
for model in summary['models']:
    cells=[]
    for name in names:
        m=model['metrics'][name]
        cells.append(f"<td>{m['mean']:.3f}<small>유효 {m['valid_count']}/{m['total']}</small></td>" if m['mean'] is not None else '<td>계산 실패</td>')
    summary_rows.append(f"<tr><th>{esc(model['model'])}</th>{''.join(cells)}<td>{model['error_count']}문항</td></tr>")
    for q in plan['rows']:
        if q['track']!='generation':continue
        folder=ROOT/model['model'].replace(':','_')
        r=json.loads((folder/(q['id']+'.json')).read_text(encoding='utf8'))
        s=json.loads((folder/(q['id']+'.scores.json')).read_text(encoding='utf8'))
        cites=re.findall(r'\[(E\d+)\]',r['response'])
        source_map={x['evidence_id']:x for x in r['sources']}
        unknown=sorted(set(cites)-set(source_map))
        cited_gold=any(source_map[c]['parent_document_id'] in q['gold'] for c in cites if c in source_map)
        flags=[]
        if not cites:flags.append('출처 표기 없음')
        if unknown:flags.append('존재하지 않는 출처 번호')
        if not cited_gold:flags.append('정답 문서에 해당하는 출처 표기 없음')
        if r['truncated']:flags.append('출력 길이 제한 도달')
        if r['input_budget_warning']:flags.append('입력 길이 확인 필요')
        if '제공된 문서에서 관련 정보를 찾을 수 없습니다.' in r['response']:flags.append('답변 가능한 문항에서 정보 없음 응답')
        audit.append({'model':model['model'],'id':q['id'],'citations':cites,'unknown':unknown,'cited_gold':cited_gold,'flags':flags})
        metric_text=' · '.join(f"{names[n]}: {s['scores'][n]:.3f}" if n in s['scores'] else f"{names[n]}: 오류" for n in names)
        details.append(f"<tr><td>{esc(model['model'])}<br>{q['id']}</td><td>{esc(q['question'])}<small>정답: {esc(q['reference'])}</small></td><td>{esc(r['response'])}<small>{esc(metric_text)}</small><strong>{esc(' / '.join(flags))}</strong><details><summary>근거·출처·오류 상세</summary><pre>{esc(json.dumps({'sources':r['sources'],'contexts':r['retrieved_contexts'],'errors':s['errors']},ensure_ascii=False,indent=2))}</pre></details></td></tr>")
(ROOT/'citation_checks.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2),encoding='utf8')
page='''<!doctype html><html lang="ko"><meta charset="utf-8"><title>Ollama 생성 모델 Ragas 예비 평가</title>
<style>body{font-family:Malgun Gothic,sans-serif;color:#173047;max-width:1250px;margin:36px auto;padding:0 22px;line-height:1.65}h1{font-size:28px}h2{margin-top:32px;font-size:21px}.note{padding:16px;background:#fff3da;border-left:5px solid #bb7a1b}table{border-collapse:collapse;width:100%;margin:16px 0}td,th{border:1px solid #d7e1eb;padding:12px;vertical-align:top;text-align:left}th{background:#edf4f7}small{display:block;color:#526578;margin-top:8px}strong{color:#a34d15}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}summary{cursor:pointer;color:#007f77}</style>
<h1>Ollama 생성 모델 비교 — Ragas 예비 평가</h1>
<p class="note">기존 개발 질문 30개에 대한 비교입니다. 독립 최종 평가가 아니며 모델의 일반 성능 순위로 해석할 수 없습니다. 채점 모델은 Qwen3 14B로 고정했고, 같은 계열 편향 가능성이 있습니다.</p>
<h2>모델별 실제 점수</h2><p>높을수록 좋습니다. 오류는 0점으로 바꾸지 않고 유효 문항 수를 표시합니다. 임의의 종합 점수는 만들지 않았습니다.</p>
<table><tr><th>생성 모델</th><th>근거 충실성</th><th>사실 정확성(F1)</th><th>질문 관련성</th><th>채점 오류</th></tr>'''+''.join(summary_rows)+'''</table>
<p>근거 충실성: 답변 주장이 검색 근거로 뒷받침되는 비율. 사실 정확성: 참고 정답과 사실 단위로 비교한 F1. 질문 관련성: 답변으로 재구성한 질문과 원 질문의 임베딩 유사도이며 사실 정확도와는 다릅니다.</p>
<h2>평가 조건</h2><p>Ollama 0.40.11 · Ragas 0.4.3 · 동일 질문/근거/프롬프트 · Q4_K_M · 생성 temperature 0, seed 42, 입력 8192, 출력 1024 · CPU 4스레드. 각 모델의 공식 대화 템플릿 사용. 채점 모델 출력 한도 4096. 관련성 임베딩은 기존 고정 BGE-M3.</p>
<p>GPU 자동 분할의 메모리 할당 실패 후 생성 모델은 모두 CPU 실행으로 통일했습니다. 공통 채점 모델은 실행 시험 후 GPU 20개 레이어/나머지 CPU로 고정하고 전 문항을 같은 설정으로 재채점했습니다. 4B와 8B의 실용 구성 비교이며 동일 규모 모델 비교는 아닙니다. 캐시는 동일 요청·실행 설정에만 적용합니다. 정답 문서는 현재 DB SHA256과 SQL로 대조했습니다.</p>
<h2>백엔드 검증 — 생성 모델 점수와 별도</h2><p>'''+f"{sum(x['pass'] for x in backend)}/{len(backend)}문항 통과. 근거 부족 30개와 추가 질문 2개에서 모델 호출 없이 처리되는지 확인했습니다."+'''</p>
<h2>문항별 답변과 근거</h2><p>출처 자동 검사는 번호의 존재와 정답 문서 연결을 확인합니다. 문장별 출처의 의미적 타당성을 보장하지 않으며 숫자·날짜·주장은 추가 검토해야 합니다.</p>
<table><tr><th>모델/문항</th><th>질문·정답</th><th>실제 답변·점수</th></tr>'''+''.join(details)+'</table></html>'
review=json.loads((ROOT/'답변_추가검토.json').read_text(encoding='utf8'))
observations=''.join(f"<li><b>{esc(x['model'])} / {', '.join(x['ids'])}</b>: {esc(x['finding'])}</li>" for x in review['observations'])
page=page.replace('<h2>문항별 답변과 근거</h2>', '<h2>점수와 별도로 확인한 실제 오류 사례</h2><p>도메인 전문가 검토 전, assistant가 원문과 대조한 관찰입니다.</p><ul>'+observations+'</ul><h2>문항별 답변과 근거</h2>')
report_dir=REPORTS_DIR/'Ragas_평가준비'
report_dir.mkdir(parents=True,exist_ok=True)
(report_dir/'Ragas_생성모델_비교보고서.html').write_text(page,encoding='utf8')
print('Report saved; no scores invented or altered.')
