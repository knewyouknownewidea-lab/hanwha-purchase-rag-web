# 공개 웹사이트 운영과 재배포

공개 주소: **https://hanwha-purchase-rag.knewyouknownewidea.chatgpt.site**

GitHub: https://github.com/knewyouknownewidea-lab/hanwha-purchase-rag-web

이 저장소는 기존 검증·배포된 v0.5.1 웹사이트와 RAG 소스를 분리한 공개 저장소입니다. 현재 공개 사이트 주소와 실제 실행 중인 PC 연결은 유지합니다. API 비밀값·암호화 토큰·모델·Python 환경은 GitHub에 포함하지 않으므로 새로 복제한 폴더에서 RAG를 실행하려면 별도 설정이 필요합니다.

2026-10-26 공개 배포. GitHub About의 Website 항목과 루트 README에 주소를 등록했습니다. 호스팅은 Sites이며 GitHub Pages는 사용하지 않습니다.

## 접속과 질문

1. 공개 링크에서 **시연 계정으로 바로 시작**을 누릅니다. 별도 ChatGPT 로그인은 필요하지 않습니다.
2. **AI에게 질문하기**에서 **웹 데이터 RAG · 업로드 포함**을 고릅니다.
3. 답변 모델 **qwen3:8b**를 선택합니다. 현재 연결된 PC에는 이 모델이 설치되어 있습니다.
4. CSV·JSON 자료를 불러오고 질문하면 현재 화면의 11종 표를 검색합니다. 첫 질문은 BGE-M3 인덱스 준비 때문에 수분 걸릴 수 있습니다.

기본 데이터와 공개 검증 자료는 모두 SAMPLE 가상 자료입니다. 이름만 받는 간이 로그인은 보안 인증이 아닙니다. 영구 저장은 브라우저에 하고, RAG에 보낸 검색 스냅샷은 세션별 임시 메모리에서 처리합니다. 스냅샷 변경·삭제·로그아웃·만료 시 이전 검색 결과를 폐기합니다. 자세한 API·크기·만료 한도는 [RAG.md](RAG.md)를 참고하세요.

## 현재 연결 구조와 운영 조건

공개 브라우저 → Sites Worker의 동일 출처 `/api/rag/*` → HTTPS 터널 → 이 PC의 인증 게이트웨이 → BGE-M3 검색·Ollama 답변.

- 화면과 중계 API는 클라우드에서 실행합니다. **RAG 서버는 현재 Windows PC에서 실행합니다. PC·Ollama·공개 연결 실행기가 켜져 있어야 답변합니다.** PC 절전·종료·연결 중단 중에는 RAG 요청이 실패합니다.
- 모든 로컬 서비스는 `127.0.0.1`에 바인딩합니다. 터널은 인증 게이트웨이 8010만 연결합니다. Ollama 11434와 검색 백엔드 8000은 직접 공개하지 않습니다.
- `RAG_ORIGIN`과 `RAG_GATEWAY_TOKEN`은 Sites의 비밀 환경변수입니다. 브라우저 HTML·GitHub·명령 인자에 비밀값을 넣지 않습니다. 로컬 토큰은 원래 Windows 계정의 DPAPI 암호화 파일로 보관하고 프로세스 환경으로만 전달합니다.
- 공개 방문자의 요청은 서명된 HttpOnly·Secure 쿠키와 화면 세션으로 격리합니다. 스냅샷·답변의 소유권과 버전을 서버에서 검사합니다. 동시 생성 1건, 방문자별·전체 호출 제한이 있으므로 여러 명이 동시에 질문하면 잠시 후 재시도 안내가 나올 수 있습니다.
- 현재 연결은 [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)을 사용합니다. 테스트용 연결로 가동 시간 보장이 없고, 터널을 다시 만들면 주소가 바뀝니다. PC 없이 상시 운영하려면 모델과 검색 서버를 상시 서버로 옮기고 고정 연결을 설정해야 합니다.

## 이 PC에서 다시 실행

이미 실행 중인 감독 프로세스가 있으면 기존 실행 창에서 Ctrl+C로 종료한 뒤 시작합니다. 새 실행기는 기존 포트가 사용 중이면 중복 실행을 거절합니다. 직접 생성한 프로세스만 종료하며 기존 Ollama는 시작하거나 종료하지 않습니다.

Ollama가 꺼져 있다면 기존 설치의 `ollama serve`를 먼저 실행합니다. 이 PC의 모델 저장 경로는 `D:\OllamaModels`입니다. `ollama list`에 `qwen3:8b`가 보여야 합니다.

저장소 루트에서 PowerShell로 실행하고 창을 유지합니다.

```powershell
& ./purchase-rag/deployment/start-public-runtime.ps1
```

이 실행기는 저장소의 `work/chunking-venv` 또는 이 작업 공간에서 준비한 `../.venv-scope-tests` Python을 사용합니다. 다른 PC에서는 backend 요구사항 설치, 공식 cloudflared 실행 파일과 아래 암호화 토큰 설정이 먼저 필요합니다. 이 PC의 설정을 일반 설치 패키지로 간주하지 마세요.

로컬 전용 경로(모두 Git 제외):

| 경로 | 용도 |
|---|---|
| `work/deployment-runtime/gateway-token.dat` | Windows 사용자 DPAPI 암호화 토큰. 다른 PC·계정에 그대로 옮겨 쓰지 않음 |
| `work/deployment-tools/cloudflared.exe` | 공식 2026.10.3 Windows amd64. 런처가 공식 SHA256 검증 |
| `work/deployment-runtime/runtime-status.json` | 실행 상태와 현재 터널 주소·관리 프로세스 번호 |
| `work/deployment-runtime/*.log` | 로컬 서비스 로그. 토큰·업로드 본문은 기록하지 않음 |

런처의 `--check`는 토큰과 실행 파일만 검사합니다. 토큰을 생성하거나 교체하지 않습니다. 기존 토큰을 바꾸면 Sites의 비밀 환경변수도 같은 값으로 바꾸고 재배포해야 합니다.

## 터널 주소가 바뀌었을 때

재시작 시 출력되는 **Sites RAG_ORIGIN 갱신 주소**를 확인합니다. Sites의 `RAG_ORIGIN`을 새 HTTPS 주소로 갱신하고 저장된 사이트 버전을 다시 배포해야 변경이 적용됩니다. 기존 토큰은 유지합니다. 웹사이트 공개 링크는 그대로입니다.

Codex에 “구매 DX 공개 사이트의 현재 터널 주소로 RAG_ORIGIN을 갱신하고 재배포해줘”라고 요청할 수 있습니다. 배포 성공 뒤 공개 URL에서 실제 질문까지 확인하고, 로컬 성공 배포 기록의 `published_origin`을 갱신합니다. 이전의 별도 구매 RAG 시연 사이트용 `deployment/start-deployment.ps1`과 이 전체 웹앱용 `start-public-runtime.ps1`을 혼용하지 마세요.

## 코드 변경 후 배포

원본 웹앱과 Worker 빌드·테스트:

```sh
npm run typecheck
npm run build:hosting
npm run test:logic
npm run test:rag
npm run test:hosting
```

`hosting/build.mjs`는 웹앱을 빌드하고 기존 esbuild로 단일 Worker ESM을 만듭니다. 새 npm 패키지는 없습니다. 별도 Sites 소스 체크아웃의 `worker/index.js`를 갱신할 때는 `--site-source <절대경로>`를 사용합니다. Sites 소스 helper로 정확한 소스를 푸시·패키징한 뒤 저장된 버전을 공개 배포합니다. GitHub에만 푸시하면 Sites 배포가 자동으로 바뀌지는 않습니다.

Site ID: `appgprj_6adec72f906c8191ac7b0db12c93efc3`. 기존 Site를 재사용하고 `.openai/hosting.json`의 ID를 보존합니다. 공개 대상도 유지합니다. 자격증명과 런타임 비밀값은 manifest에 저장하지 않습니다.

## 공개 검증

공개 URL에서 실제 BGE-M3와 qwen3:8b를 사용해 업로드한 가상 기사의 포장 방법을 검색하고 출처 파일과 함께 답변하는 것을 확인했습니다. 방문자 간 자료 격리, Secure·HttpOnly 쿠키, 임시 자료 삭제와 이전 답변 폐기도 확인했습니다. 모의 모델 응답을 공개 검증 결과로 사용하지 않았습니다.
