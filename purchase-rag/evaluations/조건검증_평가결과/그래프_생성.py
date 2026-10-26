"""저장된 전후 평가 결과로 그래프를 생성합니다. 성능 재평가/설정 변경은 하지 않습니다."""
import sys
from pathlib import Path

# Allow both Run Python File and python -m from the project folder.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from project_paths import REPORTS_DIR

import json
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.patches import Patch
from matplotlib.ticker import MaxNLocator

ROOT=Path(__file__).resolve().parent
REPORT_DIR=REPORTS_DIR/'조건검증_평가결과'
REPORT_DIR.mkdir(parents=True,exist_ok=True)
r=json.loads((ROOT/'조건검증_전후결과.json').read_text(encoding='utf8'))
font_manager.fontManager.addfont(r'C:\Windows\Fonts\malgun.ttf')
font_manager.fontManager.addfont(r'C:\Windows\Fonts\malgunbd.ttf')
plt.rcParams.update({'font.family':'Malgun Gothic','axes.unicode_minus':False,
                     'font.size':11,'axes.titlesize':15,'axes.titleweight':'bold',
                     'axes.labelcolor':'#334155','text.color':'#182b43',
                     'xtick.color':'#334155','ytick.color':'#64748b','svg.fonttype':'path'})
before_color='#8797AE';after_color='#008C83'
fig,axes=plt.subplots(2,2,figsize=(14,11.5))
fig.patch.set_facecolor('#F8FAFC')
fig.subplots_adjust(left=.07,right=.97,top=.70,bottom=.21,hspace=.42,wspace=.22)
fig.text(.07,.95,'검색 로직별 응답 가능 여부 판단 성능',fontsize=24,fontweight='bold')
fig.text(.07,.91,'같은 질문으로 비교 | BGE-M3 · 벡터 검색에만 유사도 기준 0.619865 적용',fontsize=13)

fig.legend(handles=[Patch(color=before_color,label='변경 전: 유사도 기반 검색'),
                    Patch(color=after_color,label='변경 후: 유사도 검색 + 조회 조건 검증')],
           loc='upper left',bbox_to_anchor=(.065,.89),ncol=2,frameon=False,fontsize=11)

fig.text(.07,.81,'적용 이유',fontsize=12,fontweight='bold',color='#008C83')
fig.text(.07,.775,'발주·기간이 다르거나 근거가 없는 응답 방지',fontsize=12)
fig.text(.54,.81,'선택 근거',fontsize=12,fontweight='bold',color='#008C83')
fig.text(.54,.775,'ID·날짜·항목이 명확한 DB이므로 직접 조회로 검증',fontsize=11)

for row,(group,title) in enumerate([('holdout','기존 검증 문항 30개'),('all','전체 개발 문항 60개')]):
    a,b=r['before'][group],r['after'][group]
    ax=axes[row,0];labels=['근거 없는 질문에\n응답 허용 (FP)','답변 가능한 질문에\n응답 차단 (FN)'];keys=['FP','FN']
    for offset,data,color in [(-.18,a,before_color),(.18,b,after_color)]:
        bars=ax.bar([i+offset for i in range(2)],[data[k] for k in keys],width=.34,color=color,zorder=3)
        for bar,k in zip(bars,keys):
            value=data[k];x=bar.get_x()+bar.get_width()/2
            if value==0:ax.plot(x,0,'o',color=color,markersize=5,zorder=4,clip_on=False)
            ax.text(x,value+.2,f'{value}건',ha='center',va='bottom',fontsize=12,fontweight='bold')
    ax.set_xticks(range(2),labels);ax.set_ylim(0,10);ax.set_ylabel('오류 건수 · 낮을수록 좋음')
    ax.yaxis.set_major_locator(MaxNLocator(integer=True));ax.set_title(title+' — 오류 감소',loc='left',pad=14)
    ax=axes[row,1];keys=['accuracy','precision','recall','f1'];labels=['정확도\n전체 판단','정밀도\n허용의 정확성','재현율\n답변 가능 포착','F1\n정밀도·재현율 균형']
    for offset,data,color in [(-.18,a,before_color),(.18,b,after_color)]:
        bars=ax.bar([i+offset for i in range(4)],[100*data[k] for k in keys],width=.34,color=color,zorder=3)
        for bar,k in zip(bars,keys):
            ax.text(bar.get_x()+bar.get_width()/2,100*data[k]+1.3,f'{100*data[k]:.1f}',ha='center',va='bottom',fontsize=10,fontweight='bold')
    ax.set_xticks(range(4),labels);ax.set_ylim(0,112);ax.set_yticks([0,20,40,60,80,100]);ax.set_ylabel('응답 판단 성능 (%) · 높을수록 좋음')
    ax.set_title(title+' — 분류 지표',loc='left',pad=14)

for ax in axes.flat:
    ax.set_facecolor('white');ax.grid(axis='y',color='#e4eaf1',zorder=0)
    for spine in ['top','right','left']:ax.spines[spine].set_visible(False)
    ax.spines['bottom'].set_color('#cbd5e1');ax.tick_params(axis='both',length=0,pad=8)
fig.text(.07,.125,'처리 방식: 정확한 값은 DB 조회 · 민원 내용은 벡터 검색 · 조건에 맞는 근거가 없으면 근거 부족으로 처리',fontsize=11)

fig.text(.07,.095,'평가 범위: 응답 허용·차단 판단이며 최종 답변의 정확도는 아닙니다. 위 30문항은 아래 60문항에 포함됩니다.',fontsize=10)
fig.text(.07,.06,'100%는 개선에 사용한 60문항의 재검사 결과입니다. 새로운 질문으로 독립 검증이 필요합니다.',fontsize=10,color='#9A5C08')
fig.text(.07,.032,'출처: 조건검증_전후결과.json · 지표 계산: scikit-learn · 원본 DB·임계값·저장 벡터 변경 없음',fontsize=9,color='#64748b')
fig.savefig(REPORT_DIR/'조건검증_전후_지표그래프.png',dpi=200,facecolor=fig.get_facecolor())
fig.savefig(REPORT_DIR/'조건검증_전후_지표그래프.svg',facecolor=fig.get_facecolor())
print('PNG/SVG 그래프 저장 완료')
