# 웹 업로드·구매 DB RAG (v0.5.0)

## 질문 방식

| 방식 | 대상 | 결과 |
| --- | --- | --- |
| 웹 데이터 분석 | 현재 화면 데이터 | 기존 코드 계산·비교·평가·시각화 |
| 웹 데이터 RAG | 현재 화면의 11종 표(SAMPLE + 업로드 포함) | BGE-M3 검색 → 선택한 Ollama 모델 → 답변·출처 |
| 구매 DB RAG | 별도 `purchase-rag/db/구매관리_테스트.db` | DB 정확 조회/의미 검색 → Ollama 답변·출처 |

웹의 `SUP-001`·품목코드·문자열 발주번호를 별도 구매 DB의 정수 ID로 변환하지 않습니다.

## 업로드한 자료에 질문하기

1. **데이터 불러오기**에서 CSV 또는 JSON을 선택하고 형식 검사 후 병합/교체합니다.
2. **AI에게 질문하기 → 웹 데이터 RAG**를 선택하고 실제 설치한 답변 모델을 고릅니다.
3. 원래 키를 포함해 질문합니다. 예: `PO-UP-RAG 발주 수량은?`
4. 첫 질문에서 현재 화면 데이터를 서버로 전송하고 임시 BGE-M3 검색 인덱스를 준비합니다.
5. 검색한 근거만 모델에 전달합니다. **출처**를 펼치면 표·원래 기록 키·데이터 버전을 확인합니다.

지원 표는 협력사, 품목, 발주, 계약, 재고, BOM, 원자재 시세, 환율, 임금, 경쟁사 공급, 업계 동향입니다.
병합으로 남아 있는 SAMPLE 행도 검색에 포함합니다. 업로드 원본만 검색한다고 표시하지 않습니다.
파일명은 **그 표에 마지막으로 반영한 업로드 파일명**이며 개별 행의 원본 파일·원본 행 번호가 아닙니다.
필터·정렬·행 선택은 검색 범위를 자동 제한하지 않으므로 조건은 질문에 적습니다.
지원하지 않는 날짜·기간·수치 범위 조건은 조건을 무시하지 않고 확인을 요청합니다.
전체 합계·평균·최대/최소·순위 같은 집계는 일부 검색 결과로 계산하지 않고 범위를 확인하거나 기존 웹 데이터 분석을 안내합니다.
근거가 없으면 모델 호출 없이 알립니다. 출처 번호 검증은 문장별 사실 정확성 검증을 뜻하지 않습니다.

## 저장과 변경 처리

- 영구 업로드 저장은 기존 사용자별 브라우저 IndexedDB입니다.
- 웹 RAG 질문 시 스냅샷을 서버 임시 메모리에서 문서화·임베딩·검색합니다. 업로드 원문·벡터를 디스크, 기존 Chroma DB, 공개 저장소에 쓰지 않습니다.
- 모델에는 검색된 근거만 전달합니다. 이 구성의 Ollama와 BGE-M3는 로컬에서 실행합니다.
- 병합·교체·샘플 복귀·업로드 삭제 때 진행 요청을 취소하고 이전 인덱스를 삭제합니다. 이전 버전의 늦은 답변은 표시하지 않습니다.
- 로그아웃·화면 종료 때 정리를 시도하고 누락된 정리는 등록 후 만료로 보완합니다. 새로고침·다시 로그인 시 새 세션에서 브라우저 저장본을 필요할 때 다시 인덱싱합니다.
- 서명한 HttpOnly 방문자 쿠키와 Provider마다 새로 만드는 무작위 세션 capability를 결합해 소유권을 구분합니다. 기존 간이 로그인은 실제 계정 인증이 아닙니다.

## 실행

이 저장소 루트가 웹앱이며 `purchase-rag/`에 백엔드·게이트웨이가 있습니다.
기존 `engine-dx/`, `engine-dx-inventory/`는 별도 프로젝트로 보존했습니다.
필요 환경은 Node.js 18 이상, Python 3.11, Ollama, 선택한 생성 모델과 BGE-M3입니다.
처음 인덱싱할 때 BGE-M3 모델을 다운로드합니다. 새 npm 패키지는 추가하지 않았습니다.

```powershell
# 저장소 루트
npm install
python -m venv work/rag-venv
& .\work\rag-venv\Scripts\python.exe -m pip install -r purchase-rag/backend/requirements.txt
ollama pull qwen3:8b
```

Ollama를 실행한 상태에서 첫 터미널에 백엔드를 실행합니다.

```powershell
Set-Location purchase-rag
& ..\work\rag-venv\Scripts\python.exe -m backend
```

웹 데이터 인덱스는 질문 시 자동 생성합니다. **구매 DB RAG**도 사용한다면 최초 한 번 다른 터미널에서 구축합니다.

```powershell
Set-Location purchase-rag
& ..\work\rag-venv\Scripts\python.exe -m backend.client index
```

게이트웨이와 웹 서버에 같은 `RAG_GATEWAY_TOKEN`을 서버 환경변수로 설정합니다.
32자 이상의 ASCII 비밀 토큰을 사용하고 코드·브라우저·저장소·공개 로그에 넣지 않습니다.
설정한 두 번째 터미널에서 게이트웨이를 실행합니다.

```powershell
Set-Location purchase-rag
& ..\work\rag-venv\Scripts\python.exe -m deployment
```

같은 토큰을 설정한 세 번째 터미널에서 웹 서버를 실행합니다.

```powershell
# 저장소 루트
$env:RAG_ORIGIN = 'http://127.0.0.1:8010'
npm start
```

기본 주소는 `http://localhost:5173`, 선택한 생성 모델은 `qwen3:8b`입니다.
`gemma3:4b`, `llama3.1:8b`도 실제 설치 후 명시적으로 선택할 수 있습니다.
`PORT`로 웹 포트를 바꿉니다. `RAG_ORIGIN`에는 원점 주소만 넣으며 경로·쿼리·로그인 정보를 넣지 않습니다.
HTTPS 또는 루프백 HTTP를 허용합니다. 정적 HTML만 열면 서버 RAG API가 실행되지 않습니다.
현재 PC 구성은 PC·Ollama·백엔드·게이트웨이가 켜져 있을 때 사용합니다.
외부 웹 서버의 `127.0.0.1`은 그 서버 자신을 가리키므로 외부 배포는 연결 주소·실행 환경을 별도 구성해야 합니다.

## API

브라우저는 같은 웹 서버 API만 사용하며 비밀 토큰·내부 게이트웨이 주소는 서버에 둡니다.

| 웹 API | 게이트웨이 | 동작 |
| --- | --- | --- |
| GET `/api/rag/status` | 없음 | 설정 유효성·허용 모델(설치 여부 검사는 아님) |
| POST `/api/rag/datasets` | POST `/datasets` | 스냅샷 검증·비동기 인덱싱, 202 |
| GET `/api/rag/datasets/{id}` | GET `/datasets/{id}` | indexing/ready/failed |
| DELETE `/api/rag/datasets/{id}` | DELETE `/datasets/{id}` | 메모리 스냅샷 폐기 |
| POST `/api/rag/jobs` | POST `/jobs` | 질문 작업 생성, 202 |
| GET `/api/rag/jobs/{id}` | GET `/jobs/{id}` | running/succeeded/failed |

스냅샷 본문은 `{schema_version:1,client_revision,meta:{asOf,isSample,label,sources,uploaded},data:DataSet}`입니다.
11개 표의 필드·기본 키는 `src/data/schema.ts`와 `purchase-rag/backend/web_schema.json`을 함께 검증합니다.
응답은 `{dataset_id,revision,status,row_count,chunk_count}`이며 revision은 서버가 계산한 SHA-256입니다.
웹 질문은 `{question,model,top_k,dataset:{id,revision}}`을 전송합니다.
생성·폴링 응답과 출처의 같은 dataset/revision을 검증하며 DB 숫자 필터와 혼용하지 않습니다.
별도 구매 DB 모드는 기존 계약을 유지합니다.

웹 요청의 `X-Rag-Session` capability는 브라우저에 영구 저장하지 않습니다.
웹 서버가 서명 쿠키와 결합해 게이트웨이에 방문자를 주입합니다.
브라우저의 Authorization/X-Rag-Visitor는 신뢰하지 않으며 원문·프롬프트·비밀 토큰·벡터를 로그에 출력하지 않습니다.

## 한도와 오류

- 웹 스냅샷 JSON 2MiB, 총 2,000행, 2,048청크. 기존 질문 JSON은 8KiB입니다.
- 필드·기본 키·숫자·날짜·목록·길이를 검증하며 잘못된 값을 조용히 버리지 않습니다.
- 소유자별 현재 스냅샷 1개, 전역 8세션·128MiB 예산, 등록 후 30분 만료(최대 청소 지연 60초). 모델 메모리는 별도입니다.
- 인덱싱 동시 실행을 제한하며 초과하면 429를 반환합니다.
- 웹 중계 한 번은 10초, 검색 준비는 600초, 질문 작업 대기는 660초이며 생성 모델은 기존 600초 제한입니다. 비동기 작업을 폴링해 기다립니다.
- 404는 삭제·만료·다른 세션 데이터, 409는 준비 중/버전 변경, 413/422는 크기/형식, 429는 동시 처리·한도 초과입니다.
- 상류 내부 오류·인증 정보를 그대로 브라우저에 전달하지 않습니다.

## 검증

```powershell
npm run typecheck
npm run build
npm run test:logic
npm run test:rag
python -X utf8 tests/rag-e2e.py
python -X utf8 tests/web-rag-e2e.py
python -X utf8 tests/e2e.py http://localhost:5173
```

회귀 검사는 모의 인코더/게이트웨이를 사용합니다. 실제 BGE-M3·Ollama의 업로드→검색→생성은 별도 확인합니다.
브라우저 검사는 기존 Python Playwright·Chromium을 사용합니다.
1920·1366·900·400px에서 조작·가로 넘침·12px 최소 글자를 확인합니다.

### v0.5.0 검증 결과 (2026-10-26)

| 검증 | 결과 |
| --- | --- |
| TypeScript 타입 / 한화·중립 빌드 | 통과 |
| 업로드 스키마 11종 일치 | 통과 |
| 기존 분석 smoke / 로직 | 통과 / 46개 |
| Node 중계 / TypeScript 클라이언트 | 26개 / 41개 |
| Python 백엔드 / 게이트웨이·기존 수명주기 | 43개 / 34개 |
| 구매 DB RAG 브라우저 회귀 | 29개 |
| 업로드 RAG 브라우저 회귀 | 32개 |
| 기존 전체 화면 E2E | 235개 |
| 합계(개별 항목) | 486개 통과 + smoke·스키마·타입·빌드 |

회귀는 모의 인코더·게이트웨이로 입력·소유권·버전·취소·삭제·만료·오류·수치/날짜 조건을 검증했습니다.
해상도 1920·1366·900·400px에서 새 컨트롤·가로 넘침·최소 글자도 확인했습니다.

실제 Windows 로컬 환경에서도 별도로 BGE-M3 고정 리비전과 Ollama `qwen3:8b`를 실행했습니다.
브라우저의 실제 CSV 업로드(가상 검증 데이터)에서 `PO-LIVE-1026` 수량 **7311**과 업로드 파일·원래 키·스냅샷 출처를 확인했습니다.
JSON으로 같은 발주번호를 **8422**로 교체한 뒤 새 값과 새 파일·스냅샷 출처도 확인했습니다.
기사 JSON에 기록한 가상 포장 지침을 자유 문장으로 질문해 BGE-M3 의미 검색과 실제 생성 답변 **청록색 방습백에 밀봉한 뒤 진공 포장** 및 기사 행 출처도 확인했습니다.
전체 기본 웹 데이터에 업로드를 병합한 최초 인덱싱은 이 PC(CPU 4스레드)에서 수 분 걸렸습니다.
초기 준비의 3분 제한이 짧은 것을 실제 검증 중 확인해 10분으로 늘리고 첫 질문 안내를 추가했습니다.
업로드 변경 후에는 현재 스냅샷을 다시 준비합니다. 실제 계정 인증·외부 공개 호스팅은 이 변경 범위에 포함하지 않았습니다.
