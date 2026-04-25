# AI Codebase Onboarding System (Monorepo)

Production-ready scaffolding for an AI-native developer onboarding platform.

## Structure

```txt
/codebase-onboarding-ai
  /apps
    /frontend         # Next.js app
    /backend          # FastAPI app (uv-managed)
  /packages
    /agents           # LangGraph agents (scaffold)
    /orchestrator     # LangGraph workflows (scaffold)
    /domain           # shared schemas/prompts (scaffold)
    /ingestion        # parsing/chunking/embeddings (scaffold)
    /shared           # shared utilities/types (scaffold)
  /infra
    /terraform        # AWS IaC (scaffold)
    /docker           # local infra config (Docker Compose)
  /docs
```

## Local development

### Prereqs

- Node.js \(>= 20\) + pnpm
- Python \(>= 3.10\) + `uv`
- Docker Desktop

### Start local infra (Postgres + pgvector)

```bash
pnpm docker:up
```

### Run apps (in separate terminals)

Frontend:

```bash
cd apps/frontend
pnpm dev
```

Backend:

```bash
cd apps/backend
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Health checks:

- Frontend: `http://localhost:3000`
- Backend: `http://localhost:8000/healthz`

