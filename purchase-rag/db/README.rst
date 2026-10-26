구매관리 원본 DB
================

이 폴더는 구매관리 업무 데이터와 재생성용 SQL을 보관합니다.
테이블, 컬럼, 기본키, 외래키와 기존 데이터의 ID는 그대로 유지합니다.
검색용 문서·청크·벡터와 평가 결과는 각각 data/와 evaluations/에서 관리합니다.

파일 구성
---------

* 구매관리_테스트.db: 현재 사용하는 원본 SQLite DB (총 74건)
* 구매관리_가상데이터.json: DB 생성에 사용한 가상 데이터
* schema.sql: 6개 업무 테이블과 인덱스 정의
* views.sql: 3개 조회용 뷰 정의
* seed.sql: 기존 가상 데이터 INSERT 문
* queries/: 읽기 전용 조회 예제
* query.py: 읽기 전용 조회 도구
* init_db.py: 새 파일에만 DB를 생성하는 초기화 도구

테이블 관계
-----------

* supplier: 협력사 (3건)
* part: 부품 (3건)
* supplier_part: 협력사와 공급 부품의 연결 및 기준 단가 (9건)
* orders: 협력사·부품별 발주 (24건)
* delivery: 발주별 납품 기록; 한 발주에 분할 납품 가능 (27건)
* complaint: 납품에 연결된 민원·불량 (8건)

관계는 supplier/part -> orders -> delivery -> complaint이며,
supplier_part가 supplier와 part의 공급 관계를 연결합니다.
현 구조에서 발주 한 건은 부품 하나를 가집니다.

조회용 뷰는 v_supplier_summary (협력사 요약),
v_order_status (발주·납품 수량 현황),
v_complaint_details (민원과 관련 업체·부품)입니다.

실행 방법
---------

프로젝트 루트에서 아래 명령을 실행합니다. python은 프로젝트의 Python
실행 파일로 바꿔도 됩니다. 추가 패키지는 필요하지 않습니다.::

    python -m db.query
    python -m db.query --table v_order_status
    python -m db.query --sql DB_조회예제.sql
    python -m db.query --sql 데이터_연결확인.sql

query는 읽기 전용으로 원본 DB를 열며, SQL 파일 안의 변경 명령도 거부합니다.
상대 SQL 파일명은 db/queries/를 기준으로 찾고 절대 경로도 허용합니다.

새 테스트 DB가 필요할 때는 존재하지 않는 출력 파일을 지정합니다.::

    python -m db.init_db --output ../work/새_구매관리_테스트.db

출력 폴더는 미리 존재해야 합니다. 기존 파일이 있으면 생성을 거부합니다.
스키마·뷰·데이터 입력은 외래키 검증을 켠 하나의 트랜잭션으로 실행됩니다.
이 명령은 원본 구매관리_테스트.db를 자동으로 교체하지 않습니다.
