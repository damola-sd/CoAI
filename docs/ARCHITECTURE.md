# Architecture (Scaffold)

This repository is intentionally scaffold-only in Phase 1.

## Runtime components (target)

- **Frontend**: Next.js app (developer UI)
- **Backend**: FastAPI (API + auth + persistence)
- **Agents/Orchestration**: LangGraph packages under `packages/`
- **Database**: Postgres + pgvector

## Local dev

- Docker Compose lives in `infra/docker/docker-compose.yml`
- Apps run either via Docker or natively (pnpm/uv)

