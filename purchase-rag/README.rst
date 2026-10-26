구매관리 RAG 프로젝트
====================

원본 업무 데이터, 검색용 데이터, 실험 결과, 보고서를 역할별로 관리합니다.
처음에는 db/README.rst에서 테이블 관계를 확인하고, 아래 실행 순서를 따르세요.

폴더 구성
---------

::

    구매관리 RAG/
    ├─ db/                  구매관리 원본 데이터와 SQL
    │  ├─ 구매관리_테스트.db     현재 사용하는 원본 DB (74건)
    │  ├─ 구매관리_가상데이터.json  원본 테스트 데이터
    │  ├─ schema.sql          테이블·인덱스
    │  ├─ views.sql           조회용 뷰
    │  ├─ seed.sql            테스트 레코드
    │  └─ queries/            조회 SQL 예제
    ├─ backend/             API·문서화·검색·프롬프트·답변 생성
    ├─ data/
    │  ├─ documents/        검색 문서 JSONL과 예시
    │  ├─ chunks/           라이브러리별 청크
    │  ├─ embeddings/       비교 실험용 임베딩 벡터
    │  └─ vector_store/     현재 검색용 Chroma와 active.json
    ├─ evaluations/         평가 실행 코드·기준·원시 결과
    │  ├─ datasets/         평가 질문과 정답 기준
    │  ├─ results/          비교 결과와 백엔드 검증 기록
    │  ├─ Ragas_평가준비/    Ragas 실행 코드와 생성 답변·캐시
    │  └─ Ragas_충실도_관련성/ 튜닝 전후 점수와 검토 기록
    ├─ reports/             사람이 읽는 PDF·HTML·그래프·예시
    ├─ deployment/          외부 서비스 연결과 배포 코드
    ├─ project_paths.py     실행 파일이 함께 사용하는 경로 설정
    └─ 구매관리_RAG.code-workspace

DB와 검색의 관계
----------------

협력사(supplier)와 부품(part)을 공급 관계(supplier_part)로 연결합니다.
발주(orders)에 납품(delivery)이 연결되고, 납품에 민원(complaint)이 연결됩니다.
발주 1건에는 부품 1종이 들어가고, 여러 차례 나누어 납품할 수 있습니다.

원본 DB → 검색 문서 → 청크 → BGE-M3 임베딩 → Chroma 검색 인덱스

원본 DB가 수량·가격·날짜의 기준입니다. 백엔드는 이를 읽기 전용으로 조회합니다.
벡터DB에는 의미 검색을 위한 청크·벡터와 원본 ID가 들어갑니다.
원본 DB가 변경되면 인덱스를 갱신하세요. 폴더 정리만으로 재구축할 필요는 없습니다.
실험용 data/embeddings/와 운영 검색용 data/vector_store/는 용도가 다릅니다.

실행하기
--------

구매관리_RAG.code-workspace를 VS Code로 엽니다.
기존 Python 환경은 프로젝트 옆 ../work/chunking-venv에 있습니다.
VS Code의 작업 실행 메뉴에서 DB 조회, 문서화, 서버 시작과 검색을 실행할 수 있습니다.
모든 명령의 작업 디렉터리는 이 README가 있는 프로젝트 루트입니다.

::

    python -m db.query
    python -m db.query --table v_order_status
    python -m db.query --sql DB_조회예제.sql
    python -m backend.documents
    python -m backend.manage start
    python -m backend.client status
    python -m backend.client search
    python -m backend.manage stop

서버를 실행하면 http://127.0.0.1:8000/docs 에서 API를 확인할 수 있습니다.
새로운 빈 DB가 필요할 때만 아래 명령을 사용하세요. 기존 DB를 덮어쓰지 않습니다.

::

    python -m db.init_db --output ../work/새_테스트.db

평가와 보고서
-------------

일반 검색에는 평가 스크립트를 실행할 필요가 없습니다.
아래 비교 작업은 임베딩 모델과 추가 실행 시간이 필요할 수 있습니다.

::

    python -m evaluations.청킹_비교
    python -m evaluations.공식모듈_임베딩평가
    python -m evaluations.조건검증_전후평가

과거 평가 JSON과 점수는 원래 기록을 보존합니다. 기록 안의 과거 파일 경로는 당시
실행 환경을 나타내며, 현재 실행 경로는 project_paths.py에서 관리합니다.
HTML·PDF·이미지 보고서는 reports/ 아래에서 해당 평가 이름으로 찾을 수 있습니다.
세부 백엔드 사용법은 backend/사용안내.rst를 참고하세요.

검증
----

::

    python -m unittest backend.test_backend backend.test_query_rules backend.test_prompting backend.test_generation deployment.test_gateway deployment.test_lifecycle -v

테스트는 원본 DB 복사본과 임시 인덱스를 사용합니다.
실제 DB의 테이블 구조와 데이터는 이번 폴더 정리에서 변경하지 않았습니다.

GitHub에서 받아 실행하기 (Windows)
----------------------------------

이 프로젝트는 Hanwha_DX_Claude 저장소의 purchase-rag/ 폴더에 있습니다.
Python 3.12를 설치한 뒤 PowerShell에서 다음 명령을 실행합니다.
아래 가상환경 위치는 VS Code 작업 설정과 같습니다.::

    git clone https://github.com/knewyouknownewidea-lab/Hanwha_DX_Claude.git
    cd Hanwha_DX_Claude/purchase-rag
    py -3.12 -m venv ../work/chunking-venv
    & ../work/chunking-venv/Scripts/python.exe -m pip install -r backend/requirements.txt
    & ../work/chunking-venv/Scripts/python.exe -m db.query
    & ../work/chunking-venv/Scripts/python.exe -m backend.manage start
    & ../work/chunking-venv/Scripts/python.exe -m backend.client index
    & ../work/chunking-venv/Scripts/python.exe -m backend.client status
    & ../work/chunking-venv/Scripts/python.exe -m backend.client search

검색 인덱스와 모델·채점 캐시는 Git에 포함하지 않습니다.
첫 index 실행에서 BGE-M3 모델을 다운로드하고 검색 인덱스를 생성합니다.
최초 실행에는 인터넷 연결과 추가 시간이 필요합니다.
서버 주소는 http://127.0.0.1:8000/docs 입니다.

DB 조회와 검색에는 Ollama가 필요하지 않습니다. 답변 생성에는 Ollama를 실행하고
사용할 모델을 설치해야 합니다. 예를 들어 ollama pull gemma3:4b 를 실행한 뒤
API의 model 항목에서 gemma3:4b를 선택합니다.

가상 데이터 DB와 SQL, 검색 문서·청크, 작은 임베딩 비교 파일, 평가 결과와 보고서는
저장소에 포함합니다. 이 DB는 테스트용 가상 데이터입니다.
데이터 파일의 줄바꿈은 .gitattributes로 보존하여 기존 평가용 해시를 유지합니다.
SQL로 새 DB를 생성하면 내용이 같아도 DB 파일 해시는 달라질 수 있습니다.

평가 전체를 다시 실행하려면 backend 기본 의존성 외에 청킹·그래프·평가용
라이브러리가 필요합니다. Ragas는 evaluations/Ragas_평가준비/requirements-lock.txt의
별도 환경을 사용합니다. 기존 보고서를 읽는 데는 평가 환경이 필요하지 않습니다.
