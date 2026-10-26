import uvicorn
from .gateway import create_app

if __name__ == '__main__':
    # 단일 프로세스와 로컬 바인딩을 유지합니다. 토큰/질문은 접근 로그에 남기지 않습니다.
    uvicorn.run(create_app(), host='127.0.0.1', port=8010, workers=1, access_log=False)
