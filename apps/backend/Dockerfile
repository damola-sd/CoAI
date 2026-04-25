FROM python:3.10-slim

WORKDIR /repo/apps/backend

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

COPY apps/backend/pyproject.toml /repo/apps/backend/pyproject.toml
COPY packages/orchestrator /repo/packages/orchestrator
RUN uv sync --no-dev

COPY apps/backend/app /repo/apps/backend/app
COPY apps/backend/alembic.ini /repo/apps/backend/alembic.ini
COPY apps/backend/alembic /repo/apps/backend/alembic

EXPOSE 8000

CMD ["sh", "-c", "uv run alembic upgrade head && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000"]

