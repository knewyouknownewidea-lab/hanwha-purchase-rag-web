"""현재 프로젝트의 게이트웨이/데모 터널만 관리합니다. 토큰은 환경으로만 전달됩니다."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from datetime import datetime, timezone

import httpx
import psutil

# PowerShell launchers invoke this file directly; package imports use the same paths.
if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from project_paths import ROOT as OUTPUTS, WORK_DIR

ROOT = OUTPUTS.parent
RUNTIME = WORK_DIR / 'deployment-runtime'
PYTHON = WORK_DIR / 'chunking-venv' / 'Scripts' / 'python.exe'
CLOUDFLARED = WORK_DIR / 'deployment-tools' / 'cloudflared.exe'
FRONTEND = 'https://purchase-rag-assistant-1026.knewyouknownewidea.chatgpt.site'
TUNNEL_ARGS = ['tunnel', '--url', 'http://127.0.0.1:8010', '--no-autoupdate', '--protocol', 'http2']
ORIGIN_RE = re.compile(r'https://[a-z0-9-]+\.trycloudflare\.com\b')
STATUS = RUNTIME / 'runtime-status.json'
DEPLOYMENT = OUTPUTS / 'deployment' / 'deployment.json'


def checked_path(path):
    resolved = path.resolve()
    if resolved == ROOT or not resolved.is_relative_to(ROOT):
        raise RuntimeError('관리 경로가 현재 프로젝트 내부가 아닙니다.')
    return resolved


def python_paths():
    return {PYTHON.resolve(), Path(sys._base_executable).resolve()}


def owned(proc, kind):
    """PID 파일을 신뢰하지 않고 실행 파일·전체 인자·작업 폴더를 확인합니다."""
    try:
        args, exe, cwd = proc.cmdline(), Path(proc.exe()).resolve(), Path(proc.cwd()).resolve()
        if not args:
            return False
        if kind == 'tunnel':
            return exe == CLOUDFLARED.resolve() and cwd == ROOT and args[1:] == TUNNEL_ARGS
        module = 'deployment' if kind == 'gateway' else 'backend'
        return (exe in python_paths() and cwd == OUTPUTS
                and args[1:] in (['-m', module], ['-X', 'utf8', '-m', module]))
    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
        return False


def owned_processes(kind):
    return [proc for proc in psutil.process_iter() if owned(proc, kind)]


def check_listener(port, kind):
    try:
        listeners = [item for item in psutil.net_connections(kind='tcp')
                     if item.status == psutil.CONN_LISTEN and item.laddr.port == port]
        for item in listeners:
            if item.laddr.ip not in ('127.0.0.1', '::1') or item.pid is None:
                raise RuntimeError(f'{port} 포트가 안전한 로컬 전용 연결이 아닙니다. 중복 실행하지 않습니다.')
            if not owned(psutil.Process(item.pid), kind):
                raise RuntimeError(f'{port} 포트를 다른 프로그램이 사용 중입니다. 해당 프로그램은 변경하지 않습니다.')
        return bool(listeners)
    except psutil.Error as error:
        raise RuntimeError('실행 중인 로컬 프로그램을 확인하지 못했습니다.') from error


def without_token():
    return {key: value for key, value in os.environ.items() if key.upper() != 'RAG_GATEWAY_TOKEN'}


def healthy(port, token=None):
    headers = {'Authorization': 'Bearer ' + token} if token else {}
    try:
        with httpx.Client(trust_env=False, timeout=3, follow_redirects=False) as client:
            result = client.get(f'http://127.0.0.1:{port}/health', headers=headers)
        return result.status_code == 200 and result.json().get('status') == 'ok'
    except (httpx.RequestError, ValueError, AttributeError):
        return False


def wait_health(port, kind, token=None):
    for _ in range(40):
        check_listener(port, kind)
        if healthy(port, token):
            return
        time.sleep(.5)
    raise RuntimeError(f'{port} 연결을 확인하지 못했습니다. 로그 또는 기존 비밀 값의 일치 여부를 확인하세요.')


def spawn(args, cwd, prefix, env):
    stdout_path = checked_path(RUNTIME / (prefix + '.out.log'))
    stderr_path = checked_path(RUNTIME / (prefix + '.err.log'))
    # 새 프로세스일 때만 이전 로그를 교체합니다. 토큰/질문은 출력하지 않습니다.
    with stdout_path.open('w', encoding='utf8') as out, stderr_path.open('w', encoding='utf8') as err:
        return subprocess.Popen(args, cwd=cwd, env=env, stdout=out, stderr=err,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)


def last_origin(processes):
    created = max(proc.create_time() for proc in processes)
    found = []
    for name in ('tunnel.out.log', 'tunnel.err.log'):
        path = checked_path(RUNTIME / name)
        if path.is_file() and path.stat().st_mtime >= created - 5:
            # 터널 로그만 읽습니다. 비밀 값 파일을 읽거나 출력하지 않습니다.
            found.extend(ORIGIN_RE.findall(path.read_text(encoding='utf8', errors='replace')))
    return found[-1] if found else None


def load_status():
    try:
        value = STATUS.read_text(encoding='utf-8-sig')
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else {}
    except (OSError, ValueError):
        return {}


def load_deployment():
    try:
        parsed = json.loads(DEPLOYMENT.read_text(encoding='utf-8-sig'))
        return parsed if isinstance(parsed, dict) else {}
    except (OSError, ValueError):
        return {}


def needs_origin_update(current_origin, published_record):
    """관측한 주소가 아니라 마지막 성공 배포에 실제 반영한 주소와 비교합니다."""
    if not isinstance(published_record, dict) or published_record.get('status') != 'succeeded':
        return True
    published_origin = published_record.get('published_origin')
    if not isinstance(published_origin, str) or not ORIGIN_RE.fullmatch(published_origin):
        return True
    return current_origin != published_origin


def write_status(value):
    value['updated_at_utc'] = datetime.now(timezone.utc).isoformat()
    tmp = checked_path(RUNTIME / 'runtime-status.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf8')
    tmp.replace(checked_path(STATUS))


def start():
    token = os.environ.get('RAG_GATEWAY_TOKEN', '')
    if len(token) < 32:
        raise RuntimeError('암호화된 게이트웨이 비밀 값을 불러오지 못했습니다.')
    if not PYTHON.is_file() or not CLOUDFLARED.is_file():
        raise RuntimeError('프로젝트의 Python 또는 터널 실행 파일이 없습니다.')
    if not check_listener(8000, 'backend'):
        # 기존 프로젝트 관리기를 통해서만 시작합니다. 종료 작업에서는 백엔드를 건드리지 않습니다.
        completed = subprocess.run([str(PYTHON), '-X', 'utf8', '-m', 'backend.manage', 'start'],
                                   cwd=OUTPUTS, env=without_token(), capture_output=True,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        if completed.returncode:
            raise RuntimeError('기존 백엔드를 시작하지 못했습니다. 백엔드 실행 로그를 확인하세요.')
    wait_health(8000, 'backend')
    has_gateway = check_listener(8010, 'gateway')
    gateway = owned_processes('gateway')
    if not has_gateway and not gateway:
        spawn([str(PYTHON), '-X', 'utf8', '-m', 'deployment'], OUTPUTS, 'gateway', os.environ.copy())
    wait_health(8010, 'gateway', token)
    tunnels = owned_processes('tunnel')
    new_tunnel = not tunnels
    if new_tunnel:
        spawn([str(CLOUDFLARED), *TUNNEL_ARGS], ROOT, 'tunnel', without_token())
    origin = None
    for _ in range(90):
        tunnels = owned_processes('tunnel')
        if tunnels:
            origin = last_origin(tunnels)
        if origin:
            break
        time.sleep(1)
    if not origin:
        raise RuntimeError('터널 주소를 확인하지 못했습니다. tunnel.err.log를 확인하세요.')
    if len(tunnels) != 1:
        raise RuntimeError('동일한 프로젝트의 터널이 여러 개입니다. 중지 후 다시 시작하세요.')
    published = load_deployment()
    changed = needs_origin_update(origin, published)
    write_status({'status': 'running', 'frontend_url': FRONTEND, 'origin': origin,
                  'gateway_pids': [p.pid for p in owned_processes('gateway')],
                  'tunnel_pids': [p.pid for p in tunnels], 'origin_changed': changed,
                  'needs_sites_origin_update': changed,
                  'published_origin': published.get('published_origin')})
    print('접속 주소: ' + FRONTEND)
    print('현재 AI 연결 주소: ' + origin)
    if changed:
        print('성공 배포에 기록된 연결 주소와 다르거나 확인되지 않았습니다. Codex에 위 주소로 Sites의 RAG_ORIGIN 갱신·재배포를 요청해야 웹에서 연결됩니다.')
        print('Codex는 배포 성공을 확인한 뒤 deployment.json의 published_origin도 갱신해야 합니다.')
    else:
        print('기존 터널을 재사용했습니다. PC와 실행 프로그램을 유지하세요.')


def stop_kind(kind):
    candidates = owned_processes(kind)
    candidate_ids = {proc.pid for proc in candidates}
    roots = [proc for proc in candidates if proc.ppid() not in candidate_ids]
    groups = []
    for proc in roots:
        try:
            tree = proc.children(recursive=True) + [proc]
            if not all(owned(item, kind) for item in tree):
                raise RuntimeError('다른 작업의 자식 프로세스가 있어 자동 종료하지 않습니다.')
            groups.append([(item, item.create_time()) for item in tree])
        except psutil.NoSuchProcess:
            continue
    # 전체 검사 후에만 종료합니다. PID가 재사용되면 건드리지 않습니다.
    for group in groups:
        touched = []
        for proc, created in group:
            try:
                if proc.create_time() != created or not owned(proc, kind):
                    raise RuntimeError('프로세스가 변경되어 종료하지 않습니다.')
                proc.terminate()
                touched.append(proc)
            except psutil.NoSuchProcess:
                continue
        _, alive = psutil.wait_procs(touched, timeout=5)
        for proc in alive:
            try:
                if owned(proc, kind):
                    proc.kill()
            except psutil.NoSuchProcess:
                pass


def stop():
    # 클라우드 터널을 먼저 닫고 게이트웨이만 종료합니다.
    stop_kind('tunnel')
    stop_kind('gateway')
    previous = load_status()
    write_status({'status': 'stopped', 'frontend_url': FRONTEND, 'origin': previous.get('origin'),
                  'gateway_pids': [], 'tunnel_pids': [], 'origin_changed': False})
    print('이 프로젝트의 배포 연결만 중지했습니다. 기존 백엔드와 Ollama는 유지했습니다.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('start', 'stop'))
    args = parser.parse_args()
    for path in (OUTPUTS, RUNTIME, PYTHON, CLOUDFLARED, STATUS, DEPLOYMENT):
        checked_path(path)
    RUNTIME.mkdir(parents=True, exist_ok=True)
    try:
        start() if args.action == 'start' else stop()
    except RuntimeError as error:
        # 이 모듈에서 직접 정한 안내 문구만 출력합니다. 토큰/HTTP 예외 원문은 포함하지 않습니다.
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, psutil.Error):
        print('배포 연결을 완료하지 못했습니다. 사용안내와 로컬 로그를 확인하세요.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
