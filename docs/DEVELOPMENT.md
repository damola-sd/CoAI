# Development

## Frontend

```bash
cd apps/frontend
pnpm dev
```

## Backend

```bash
cd apps/backend
uv sync
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## Local database

```bash
pnpm docker:up
```

