# 공개 Sites Worker

기존 `dist/index.html`과 RAG Fetch 중계 코어를 단일 Worker ESM으로 묶습니다. 모델·임베딩은 RAG 서버에서 실행하고 Worker는 같은 출처의 API를 중계합니다. 브라우저에 게이트웨이 주소나 인증 토큰을 넣지 않습니다.

```sh
node hosting/build.mjs
node --test hosting/handler.test.mjs hosting/artifact.test.mjs
```

기본 빌드는 웹 앱을 먼저 빌드하고 `hosting/dist/server/index.js`를 만듭니다. 이미 최신 웹 앱 빌드를 확인했다면 `--skip-app-build`를 사용할 수 있습니다.

```sh
node hosting/build.mjs --out <artifact-directory> --site-source <Sites-checkout>
```

`--out`은 `<artifact-directory>/server/index.js`를 만듭니다. `--site-source`는 번들을 Sites `worker-esm` 스타터의 `worker/index.js`에 복사합니다. 이후 스타터의 `scripts/build.sh`와 `scripts/validate-artifact.mjs`로 Sites 배포 산출물을 만듭니다. Site ID·hosting manifest·배포 호출은 이 스크립트가 변경하지 않습니다.

런타임 환경변수는 `RAG_ORIGIN`, `RAG_GATEWAY_TOKEN`이며 기존 중계 코어와 동일합니다. 선택 항목 `ANTHROPIC_API_KEY`, `LLM_MODEL`은 기존 LLM 질문 해석 기능에 사용합니다. 비밀값은 Sites의 서버 환경변수로 설정하고 소스·명령 인자·정적 HTML에 기록하지 않습니다.

`/api/rag/*`는 상태·업로드 스냅샷·질문 작업을 중계합니다. `/api/ai/status`는 실제 LLM 설정 여부를 반환하며, 설정이 없으면 `/api/ai/interpret`는 명확한 503 오류를 반환합니다. 다른 `/api/*`는 JSON 404이며, 일반 GET/HEAD 경로에는 기존 SPA를 제공합니다. 응답에는 `no-store`가 적용됩니다.
