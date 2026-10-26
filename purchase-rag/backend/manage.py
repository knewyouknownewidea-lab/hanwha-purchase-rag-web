"""현재 프로젝트의 백엔드만 백그라운드에서 시작/중지합니다."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
import psutil

from project_paths import ROOT, WORK_DIR as WORK
PID=WORK/'backend-server.pid'

def owned_process():
    if not PID.exists(): return None
    try:
        proc=psutil.Process(int(PID.read_text(encoding='utf-8-sig').strip()))
        args=proc.cmdline()
        if '-m' not in args or args[args.index('-m')+1]!='backend' or Path(proc.cwd()).resolve()!=ROOT:
            raise RuntimeError('PID가 현재 프로젝트 서버와 다릅니다. 해당 프로세스는 중지하지 않습니다.')
        return proc
    except psutil.NoSuchProcess:
        return None

def main():
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['start','stop']);args=parser.parse_args()
    WORK.mkdir(exist_ok=True)
    proc=owned_process()
    if args.action=='stop':
        if proc:
            children=proc.children(recursive=True)
            for child in children: child.terminate()
            proc.terminate()
            _,alive=psutil.wait_procs(children+[proc],timeout=5)
            for item in alive: item.kill()
        PID.unlink(missing_ok=True)
        print('백엔드를 중지했습니다. 벡터 DB 파일은 유지됩니다.')
        return
    if proc:
        print('이미 실행 중입니다: http://127.0.0.1:8000/docs')
        return
    with (WORK/'backend-server.log').open('a',encoding='utf8') as stdout, (WORK/'backend-server-error.log').open('a',encoding='utf8') as stderr:
        child=subprocess.Popen([sys.executable,'-X','utf8','-m','backend'],cwd=ROOT,
                               stdout=stdout,stderr=stderr,
                               creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
    PID.write_text(str(child.pid),encoding='utf8')
    for _ in range(40):
        if child.poll() is not None:
            raise RuntimeError('서버 실행에 실패했습니다. work/backend-server-error.log를 확인하세요.')
        try:
            with urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=1) as r:
                if json.load(r).get('status')=='ok':
                    print('백엔드 실행 완료: http://127.0.0.1:8000/docs')
                    return
        except OSError: pass
        time.sleep(.5)
    raise RuntimeError('서버 응답이 늦습니다. 실행 로그를 확인하세요.')

if __name__=='__main__':main()
