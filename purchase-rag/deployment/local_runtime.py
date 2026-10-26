"""DPAPI 비밀과 로컬 서비스 감독. --public은 인증 게이트웨이 8010만 터널로 연결합니다."""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.request

import psutil

REPO = Path(__file__).resolve().parents[2]
RAG = REPO / 'purchase-rag'
WORK = REPO / 'work'
RUNTIME = WORK / 'deployment-runtime'
TOKEN_FILE = RUNTIME / 'gateway-token.dat'
CLOUDFLARED = WORK / 'deployment-tools' / 'cloudflared.exe'
CLOUDFLARED_SHA256 = '76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2'
CLOUDFLARED_RELEASE = '2026.10.3'
TUNNEL_ARGS = ['tunnel', '--url', 'http://127.0.0.1:8010', '--no-autoupdate', '--protocol', 'http2', '--metrics', '127.0.0.1:0', '--loglevel', 'info']
ORIGIN = re.compile(r'https://[a-z0-9-]+\.trycloudflare\.com\b')
NODE_CODE = "import { createAppServer } from './server/index.mjs'; createAppServer().listen(5173, '127.0.0.1');"


def decrypt_dpapi(ciphertext):
    """ConvertFrom-SecureString의 기본 Windows 사용자 DPAPI 형식. 평문 출력/파일 없음."""
    if os.name != 'nt':
        raise RuntimeError('이 실행기는 원래 Windows 계정의 DPAPI 토큰이 필요합니다.')
    class Blob(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]
    buffer = (ctypes.c_ubyte * len(ciphertext)).from_buffer_copy(ciphertext)
    source, target = Blob(len(ciphertext), buffer), Blob()
    unprotect = ctypes.windll.crypt32.CryptUnprotectData
    unprotect.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                         ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    unprotect.restype = wintypes.BOOL
    if not unprotect(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)):
        raise RuntimeError('현재 Windows 계정에서 게이트웨이 토큰을 복호화하지 못했습니다.')
    try:
        return ctypes.string_at(target.data, target.size).decode('utf-16-le')
    finally:
        ctypes.memset(target.data, 0, target.size)
        local_free = ctypes.windll.kernel32.LocalFree
        local_free.argtypes, local_free.restype = [ctypes.c_void_p], ctypes.c_void_p
        local_free(target.data)


def load_token(path=TOKEN_FILE):
    try:
        if path.stat().st_size > 65536:
            raise ValueError()
        encrypted = path.read_text(encoding='utf-8-sig').strip()
        value = decrypt_dpapi(bytes.fromhex(encrypted))
        if not re.fullmatch(r'[\x21-\x7e]{32,4096}', value):
            raise ValueError()
        return value
    except (OSError, ValueError, UnicodeError):
        raise RuntimeError('암호화된 게이트웨이 토큰 파일을 확인해 주세요. 토큰은 이 실행기가 생성하거나 교체하지 않습니다.') from None


def verify_cloudflared(path=CLOUDFLARED):
    if not path.is_file():
        raise RuntimeError('cloudflared 실행 파일이 없거나 공식 릴리스 SHA256과 다릅니다.')
    with path.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if digest != CLOUDFLARED_SHA256:
        raise RuntimeError('cloudflared 실행 파일이 없거나 공식 릴리스 SHA256과 다릅니다.')
    if any((Path.home() / '.cloudflared' / filename).is_file() for filename in ('config.yml', 'config.yaml')):
        raise RuntimeError('기존 cloudflared 구성 파일이 있어 Quick Tunnel을 시작하지 않습니다. 기존 구성은 변경하지 않았습니다.')


def child_env(token, kind):
    env = dict(os.environ, PYTHONUTF8='1')
    # 로컬 토큰과 외부 AI 키를 터널/백엔드 프로세스에 전달하지 않습니다.
    for key in list(env):
        if key.upper() in ('RAG_GATEWAY_TOKEN', 'RAG_ORIGIN'):
            del env[key]
    if kind in ('gateway', 'web'):
        env['RAG_GATEWAY_TOKEN'] = token
    if kind == 'web':
        env.update(RAG_ORIGIN='http://127.0.0.1:8010', PORT='5173')
    if kind in ('tunnel', 'backend'):
        for key in list(env):
            if key.upper().endswith(('_TOKEN', '_SECRET', '_API_KEY', '_PASSWORD')) or (kind == 'tunnel' and key.upper().startswith('TUNNEL_')):
                del env[key]
    return env


def specs(public=False):
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Node.js 실행 파일을 찾을 수 없습니다.')
    values = [('backend', [sys.executable, '-X', 'utf8', '-m', 'backend'], RAG, 'http://127.0.0.1:8000/health'),
              ('gateway', [sys.executable, '-X', 'utf8', '-m', 'deployment'], RAG, 'http://127.0.0.1:8010/health'),
              ('web', [node, '--input-type=module', '-e', NODE_CODE], REPO, 'http://127.0.0.1:5173/api/rag/status')]
    if public:
        values.append(('tunnel', [str(CLOUDFLARED), *TUNNEL_ARGS], REPO, None))
    return values


def ensure_ports_free():
    try:
        if any(item.status == psutil.CONN_LISTEN and item.laddr.port in (8000, 8010, 5173) for item in psutil.net_connections(kind='tcp')):
            raise RuntimeError('이전 웹/RAG 실행기가 포트를 사용 중입니다. 해당 실행기를 먼저 종료해 주세요. 기존 프로세스는 변경하지 않았습니다.')
    except psutil.Error:
        raise RuntimeError('기존 서비스 포트의 소유권을 확인하지 못했습니다.') from None


def request_json(url, token=None):
    headers = {'Authorization': 'Bearer ' + token} if token else {}
    request = urllib.request.Request(url, headers=headers)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=3) as response:
        return json.load(response)


def wait_ready(child, name, url, token):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise RuntimeError('로컬 서비스가 시작되지 못했습니다. work/deployment-runtime 로그를 확인해 주세요.')
        try:
            value = request_json(url, token if name == 'gateway' else None)
            if (value.get('enabled') is True if name == 'web' else value.get('status') == 'ok'):
                return
        except (OSError, ValueError, AttributeError):
            pass
        time.sleep(.5)
    raise RuntimeError('로컬 서비스 준비 시간이 초과되었습니다. 로컬 실행 로그를 확인해 주세요.')


def tunnel_origin(path):
    if not path.is_file():
        return None
    with path.open('rb') as stream:
        stream.seek(max(0, path.stat().st_size - 1024 * 1024))
        values = ORIGIN.findall(stream.read().decode('utf8', errors='replace'))
    return values[-1] if values else None


def write_status(value):
    # 공개 연결 주소와 직접 생성한 프로세스 번호만 보관합니다. 비밀/질문/업로드는 기록하지 않습니다.
    payload = {**value, 'updated_at_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    temporary = RUNTIME / 'runtime-status.tmp'
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf8')
    temporary.replace(RUNTIME / 'runtime-status.json')


def stop_children(children):
    for child, command, cwd in reversed(children):
        if child.poll() is not None:
            continue
        try:
            root = psutil.Process(child.pid)
            group = root.children(recursive=True) + [root]
            expected_exes = {Path(command[0]).resolve()}
            if command[0] == sys.executable:
                expected_exes.add(Path(sys._base_executable).resolve())
            if any(Path(item.exe()).resolve() not in expected_exes or Path(item.cwd()).resolve() != cwd.resolve() or item.cmdline()[1:] != command[1:] for item in group):
                raise RuntimeError('다른 프로세스가 섞여 있어 자동 종료하지 않았습니다. 실행 로그와 포트를 확인해 주세요.')
            for item in group:
                item.terminate()
            _, alive = psutil.wait_procs(group, timeout=5)
            for item in alive:
                item.kill()
        except psutil.NoSuchProcess:
            continue


def run(public=False):
    token = load_token()
    plan = specs(public)
    if public:
        verify_cloudflared()
    ensure_ports_free()
    try:
        request_json('http://127.0.0.1:11434/api/tags')
    except (OSError, ValueError):
        raise RuntimeError('기존 로컬 Ollama를 먼저 실행해 주세요. 이 실행기는 Ollama를 시작하거나 종료하지 않습니다.') from None
    RUNTIME.mkdir(parents=True, exist_ok=True)
    children, logs, origin = [], [], None
    try:
        for name, command, cwd, url in plan:
            path = RUNTIME / (name + '.log')
            log = path.open('w', encoding='utf8')
            logs.append(log)
            child = subprocess.Popen(command, cwd=cwd, env=child_env(token, name), stdout=log, stderr=log,
                                     creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            children.append((child, command, cwd))
            if url:
                wait_ready(child, name, url, token)
            else:
                deadline = time.monotonic() + 90
                while time.monotonic() < deadline:
                    if child.poll() is not None:
                        raise RuntimeError('공개 게이트웨이 터널이 시작되지 못했습니다. tunnel.log를 확인해 주세요.')
                    origin = tunnel_origin(path)
                    if origin:
                        break
                    time.sleep(.5)
                if not origin:
                    raise RuntimeError('공개 터널 주소를 확인하지 못했습니다. tunnel.log를 확인해 주세요.')
            print(name + ' ready', flush=True)
        write_status({'status': 'running', 'origin': origin, 'gateway_target': 'http://127.0.0.1:8010',
                      'public_tunnel': public, 'pids': {spec[0]: child[0].pid for spec, child in zip(plan, children)}})
        print('로컬 웹: http://127.0.0.1:5173/', flush=True)
        if origin:
            print('Sites RAG_ORIGIN 갱신 주소: ' + origin, flush=True)
            print('Quick Tunnel 재시작으로 주소가 바뀌면 Sites 환경 갱신·재배포가 필요합니다.', flush=True)
        while True:
            if any(child.poll() is not None for child, _command, _cwd in children):
                raise RuntimeError('로컬 서비스가 종료되었습니다. 실행 로그를 확인해 주세요.')
            time.sleep(1)
    finally:
        stop_children(children)
        for log in logs:
            log.close()
        write_status({'status': 'stopped', 'origin': origin, 'public_tunnel': False, 'pids': {}})


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf8')
    parser = argparse.ArgumentParser(description='암호화된 토큰으로 구매 RAG와 웹을 실행합니다. Ollama는 별도로 유지합니다.')
    parser.add_argument('--public', action='store_true', help='인증 게이트웨이 8010만 Quick Tunnel로 노출')
    parser.add_argument('--check', action='store_true', help='토큰·실행 파일만 검증하고 서비스를 시작하지 않음')
    args = parser.parse_args(argv)
    try:
        if args.check:
            load_token()
            specs(args.public)
            if args.public:
                verify_cloudflared()
            print('암호화 토큰과 런타임 파일 검증 완료. 서비스는 변경하지 않았습니다.', flush=True)
        else:
            run(args.public)
        return 0
    except KeyboardInterrupt:
        return 0
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
