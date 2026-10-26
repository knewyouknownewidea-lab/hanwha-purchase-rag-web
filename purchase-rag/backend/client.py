"""VS Code 작업 메뉴에서 API를 호출하는 간단한 클라이언트."""
import argparse
import json
import urllib.request
import urllib.error

p=argparse.ArgumentParser()
p.add_argument('action',choices=['index','status','search'])
p.add_argument('--question',default='베어링 완충 포장이 부족하다는 민원을 찾아줘')
p.add_argument('--order-id',type=int)
a=p.parse_args()
payload=None
if a.action=='index': payload={}
if a.action=='search':
    payload={'question':a.question,'top_k':3}
    if a.order_id: payload['order_id']=a.order_id
data=None if payload is None else json.dumps(payload).encode('utf8')
req=urllib.request.Request('http://127.0.0.1:8000/'+a.action,data=data,headers={'Content-Type':'application/json'})
try:
    with urllib.request.urlopen(req,timeout=600) as r:
        print(json.dumps(json.load(r),ensure_ascii=False,indent=2))
except urllib.error.HTTPError as e:
    print(e.read().decode('utf8'));raise SystemExit(1)
except urllib.error.URLError:
    print('먼저 VS Code의 백엔드: 서버 시작 작업을 실행하세요.');raise SystemExit(1)
