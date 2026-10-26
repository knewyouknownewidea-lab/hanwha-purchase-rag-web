import uvicorn

if __name__ == '__main__':
    # 현재 PC에서만 접근합니다. 이 로컬 저장 방식은 단일 프로세스로 실행합니다.
    uvicorn.run('backend.app:app', host='127.0.0.1', port=8000, workers=1)
