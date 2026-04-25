# AI Codebase Onboarding AI

An AI-powered codebase onboarding app.

- **Frontend**: Next.js UI
- **Backend**: FastAPI API + ingestion + RAG retrieval
- **Storage**: Postgres (optionally `pgvector`) + repo storage on disk (local) / EFS (AWS)
- **LLM**: OpenAI (chat + embeddings) with graceful fallback (text search / local answer)

## Architecture (local + AWS)

```mermaid
flowchart LR
  Browser["Browser"] -->|HTTP| ALB["ALB (AWS)<br/>Path-based routing"]
  ALB -->|/ (Next.js)| FE["ECS Fargate<br/>Frontend (Next.js)"]
  ALB -->|/repos, /qa, /healthz| BE["ECS Fargate<br/>Backend (FastAPI)"]

  BE -->|SQLAlchemy| DB[(RDS Postgres)]
  BE -->|repo storage| EFS[(EFS /data/repos)]
  BE -->|chat + embeddings| OAI[(OpenAI API)]

  subgraph Local
    FE2["Next.js (dev)"] -->|HTTP| BE2["FastAPI (dev)"]
    BE2 --> PG["Postgres + pgvector<br/>Docker"]
    BE2 --> Disk["Local disk<br/>COAI_REPO_STORAGE_PATH"]
    BE2 --> OAI2[(OpenAI API)]
  end
```

## Repo layout

```txt
/apps
  /frontend         # Next.js app
  /backend          # FastAPI app
/packages
  /orchestrator     # LangGraph workflows used by /qa/stream
/infra
  /docker           # local docker compose (postgres)
  /terraform        # AWS (ECS Fargate, ALB, ECR, RDS, EFS, Secrets Manager)
```

## Run locally

### Prereqs
- Node.js >= 20 + pnpm
- Python >= 3.10 + `uv`
- Docker Desktop (for Postgres)

### 1) Start Postgres (local)

From repo root:

```bash
pnpm docker:up
```

### 2) Configure backend env (local)

Create `apps/backend/.env` (or export env vars) with at least:

```bash
COAI_ENVIRONMENT=local
COAI_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/codebase_onboarding
COAI_REPO_STORAGE_PATH=/tmp/coai/repos

# Optional (enables /qa/stream + OpenAI answers)
COAI_OPENAI_API_KEY=sk-...
COAI_OPENAI_MODEL=gpt-4.1-mini

# Optional (enables embeddings; retrieval falls back if embeddings fail)
COAI_EMBEDDINGS_PROVIDER=openai
COAI_OPENAI_EMBEDDINGS_MODEL=text-embedding-3-small
```

### 3) Run backend (local)

```bash
cd apps/backend
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 4) Run frontend (local)

```bash
cd apps/frontend
pnpm dev
```

Open:
- **Frontend**: `http://localhost:3000`
- **Backend health**: `http://localhost:8000/healthz`
- **Backend docs**: `http://localhost:8000/docs`

## Using the app

### Ingest a repo
- **Remote git**: `POST /repos` with `{ "url": "https://github.com/org/repo" }`
- **Local zip upload**: `POST /repos/upload` (multipart form with `file=.zip`)
- Poll repo state: `GET /repos/{id}` until **`ready`** or **`failed`**

### Ask questions
- **Streaming** (recommended): `POST /qa/stream` (requires `COAI_OPENAI_API_KEY`)
- **Non-streaming**: `POST /qa` (uses OpenAI if configured, otherwise local extractive answer)

## Deploy to AWS (Terraform)

The AWS deployment provisions:
- **ECR** repos for backend + frontend images
- **ECS Fargate** services behind a single **ALB**
- **RDS Postgres** in private subnets
- **EFS** mounted into backend task at `/data` (repo storage)
- **Secrets Manager** for OpenAI key + DB password, injected into ECS tasks

### Prereqs
- Terraform >= 1.6
- AWS credentials configured (SSO or access keys)
- Docker (for building/pushing images)

### 1) Create Terraform variables

Copy `infra/terraform/terraform.tfvars` and set real values (do not commit secrets):

- `aws_region` (example: `"eu-west-2"`)
- `backend_image` / `frontend_image` (ECR URIs + tag)
- `openai_api_key`
- `db_password`

### 2) Provision AWS resources

```bash
cd infra/terraform
terraform init
terraform apply -auto-approve
```

### 3) Build and push images to ECR

Use the ECR URLs printed by Terraform outputs.

Important:
- Build from the **repo root** (so `apps/...` paths resolve).
- On Apple Silicon, build **linux/amd64** for Fargate:
- In zsh, tag variables should use braces: `"${ECR_BACKEND_REPO}:latest"`

```bash
export AWS_REGION="eu-west-2"
export AWS_ACCOUNT_ID="YOUR_ACCOUNT_ID"

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

export ECR_BACKEND_REPO="$(cd infra/terraform && terraform output -raw ecr_backend_repository_url)"
export ECR_FRONTEND_REPO="$(cd infra/terraform && terraform output -raw ecr_frontend_repository_url)"

cd .
docker buildx build --platform linux/amd64 -f apps/backend/Dockerfile  -t "${ECR_BACKEND_REPO}:latest"  --push .
docker buildx build --platform linux/amd64 -f apps/frontend/Dockerfile -t "${ECR_FRONTEND_REPO}:latest" --push .
```

### 4) Roll out new images / config

Terraform updates services when task definitions change. You can also force a redeploy:

```bash
aws ecs update-service --region "$AWS_REGION" --cluster "coai-cluster" --service "coai-backend" --force-new-deployment
aws ecs update-service --region "$AWS_REGION" --cluster "coai-cluster" --service "coai-frontend" --force-new-deployment
```

### 5) Verify + logs

- Get the URL:

```bash
cd infra/terraform
terraform output -raw alb_url
```

- Tail logs:

```bash
aws logs tail "/ecs/coai/backend" --region "$AWS_REGION" --follow
aws logs tail "/ecs/coai/frontend" --region "$AWS_REGION" --follow
```

## Troubleshooting

### `/qa/stream` returns `401 invalid_api_key`
Your `coai/openai_api_key` value in Secrets Manager is wrong. Update `openai_api_key` in `infra/terraform/terraform.tfvars` and re-run `terraform apply`.

### ECS task error: `EFS IAM authorization requires a task role`
When using EFS `authorization_config { iam = "ENABLED" }`, the task definition must have **`task_role_arn`** and that role must include EFS client permissions.

### Frontend logs: `exec format error`
The image architecture doesn’t match the task. On Apple Silicon, build/push with:

```bash
docker buildx build --platform linux/amd64 ...
```

### Frontend calling `http://localhost:8000` in AWS
Use same-origin API calls in the frontend (recommended) or set `NEXT_PUBLIC_API_BASE_URL` correctly **at build time**.

## Security notes
- **Never commit** `terraform.tfvars` with real secrets.
- Secrets are injected into ECS tasks via **Secrets Manager**.

