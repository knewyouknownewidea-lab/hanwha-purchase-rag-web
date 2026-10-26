# 웹 가격 비교 설명 API

브라우저는 `POST /api/rag/price-explanations`에 `{question, model: "qwen3:8b", context: PriceRagContext}`를 전달합니다. `X-Rag-Session`과 서명 방문자 쿠키를 함께 사용합니다. Worker/Node는 고정 게이트웨이 `POST /price-explanations`로만 중계하고, 게이트웨이는 방문자 소유자를 추가해 로컬 `POST /price/answer`를 호출합니다. 새 외부 URL이나 기존 DB 정수 ID는 입력받지 않습니다.

등록 응답은 202이며 `{job_id, status:"running", price_context:{analysis_id,revision}}`입니다. 기존 `GET /api/rag/jobs/{job_id}`를 같은 세션으로 폴링합니다. 성공 응답의 `result.price_context`는 바깥 작업의 값과 같아야 합니다. 오래된 분석·변경된 가격 조건의 응답 표시는 프런트에서 이 두 값을 대조해 폐기합니다. 처리 중 한 작업, 방문자/전체 질문 한도, 작업 소유권·보관 기간은 기존 Jobs 계약과 같습니다.

가격 등록 경로만 실제 UTF-8 본문 256 KiB를 허용합니다. 일반 작업 8 KiB 및 웹 스냅샷 2 MiB 한도는 그대로입니다. `PriceRagContext`의 필드는 `src/lib/priceComparison.ts`에 정의되어 있습니다. 서버는 원시 협력사 견적·외부 완성부품 견적으로 13개 조건, 외부 중앙값·범위·건수, 업체별 상태·차액·차이율을 재검산합니다. 원자재 가격·환율·기존 평가점수는 이 계산에 사용하지 않습니다. 클라이언트가 전달한 사유 문장은 생성 프롬프트에 넣지 않습니다.

선택 품목에 맞는 비교 조건이 없거나 가격 기준일이 다른 경우 요청 자체를 형식 오류로 거절하지 않고, 도메인과 같은 `needs_confirmation`/`excluded` 판정과 null 계산값을 검증합니다. 다른 품목의 SAMPLE 문서나 다른 기준일 문서를 가져오지 않습니다. TypeScript에서 실제 10개 품목의 샘플·업로드 스냅샷 20개를 생성해 Python 계약을 대조하는 회귀 테스트가 포함되어 있습니다(프런트 Node/tsx 의존성이 설치된 환경).

`context.indicators`에는 같은 화면의 `MarketIndicator[]`를 최대 20개 담습니다. 서버는 정확한 필드·상태·유한 수치·출처 URL·관측/조회 시각을 검증하고 `calculation_text`에 별도 코드 문장으로 표시합니다. 실패·미연결·조회 중 상태의 값은 null이어야 하며 예시는 SAMPLE이어야 합니다. 지표나 API 수치는 모델 입력·가격 계산에 사용하지 않습니다. 이 정보는 질문 전송 시점에 공유한 화면 스냅샷이며, 이 답변에서 재조회한 최신값을 뜻하지 않습니다. 늦게 끝난 API 조회는 다음 질문에 반영됩니다.

결과의 `calculation_text`는 코드가 만든 수치·조건 설명, `explanation`은 문서 근거의 정성 설명이며, `answer`는 두 문장을 합친 것입니다. 생성 설명에 출처 표기 외의 숫자가 들어가면 설명을 폐기하고 코드 계산만 유지합니다. 근거 문서가 없으면 임베딩·모델 호출 없이 `insufficient_evidence`와 `관련 근거를 찾지 못함`을 반환합니다.

가격 설명의 생성 프롬프트에 한해서 질문·문서 본문·출처 식별자 속 숫자는 `[조건값]`으로 가립니다. `[E1]` 같은 인용 표시는 유지합니다. 검색·임베딩은 원문을 사용하며 공개 출처 metadata는 원래 코드·문서명·날짜·페이지를 보존합니다. 모델에는 가린 값을 복원하지 말고 수치·정밀 조건은 화면의 원본 출처에서 확인하도록 안내하라고 지시합니다. 일반 구매 DB/웹 RAG의 프롬프트는 바꾸지 않습니다.

모델의 작업은 문서에 있는 검사·납품 조건 요약과 원가 차이 사유 기재 여부를 각각 한 문장으로 설명하는 것입니다. 각 문장에 실제 검색 문서 인용을 붙이도록 요구하며, 계산에 관한 사용자 질문은 참고 문맥으로만 전달합니다. 인용이 없거나 제공되지 않은 번호이면 기존 생성 검증에서 거절하며, 서버가 인용을 대신 만들어 붙이지 않습니다.

별도 `price_sample_evidence.json`은 `src/data/priceSample.ts`의 7개 가상 조건 문서를 그대로 미러합니다. 문서는 SAMPLE이며 실제 기관 자료가 아닙니다. 현재 레코드의 품목·업체·레코드 ID·문서명·날짜·페이지·전체 비교 조건이 일치할 때만 검색합니다. 문서에는 편집 가능한 금액을 고정하지 않습니다. 따라서 외부 견적 금액 편집은 새로 계산되지만 조건을 바꾸면 옛 조건 문서를 쓰지 않습니다. 실제 업로드 자료를 이 SAMPLE 문서에 임의 연결하지 않습니다.

검색은 기존 BGE 인스턴스·잠금을 사용하는 일반 벡터 검색이며 기존 Ollama 생성·프롬프트 가드를 재사용합니다. 문서 벡터는 메모리에만 보관하고 기존 구매 DB 벡터나 11종 웹 데이터 표를 바꾸지 않습니다. 출처 metadata는 `document_id`, `document_title`, `document_date`, `page`, `item_code`, `supplier_ids`, `record_ids`, `data_label`, `analysis_id`, `revision`, `source_refs`를 제공합니다.

검증 명령(저장소 루트 또는 purchase-rag 폴더에 맞게 실행):

```text
node --test tests/rag-server.test.mjs tests/price-rag-server.test.mjs
python -m unittest backend.test_price_evidence deployment.test_price_gateway
```
