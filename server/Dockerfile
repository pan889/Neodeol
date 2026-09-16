FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# 의존성만 먼저 복사해 레이어 캐시를 살린다.
COPY requirements.txt ./
RUN pip install -r requirements.txt

# 개발 시에는 docker-compose 가 ./server/src 를 /app/src 로 다시 마운트한다.
# 이 COPY 는 compose 없이 이미지 단독 실행할 때를 위한 것이다.
COPY src ./src

ENV PYTHONPATH=/app/src
EXPOSE 8000

CMD ["uvicorn", "neodeol.net.app:app", "--host", "0.0.0.0", "--port", "8000"]
