# Terraform: ECS Fargate + ECR + RDS (Postgres)

This folder provisions:
- ECR repositories for `backend` and `frontend`
- ECS Fargate cluster + services behind an Application Load Balancer (ALB)
- RDS Postgres in private subnets

## Prereqs
- Terraform >= 1.6
- AWS credentials configured (e.g. `aws configure` / SSO)

## Quick start

1) Create a `terraform.tfvars`:

```hcl
aws_region = "us-east-1"
project_name = "coai"

# Images (push these to ECR first)
# Use the ECR repo URLs Terraform outputs, e.g.
# backend_image  = "<ecr_backend_repository_url>:latest"
# frontend_image = "<ecr_frontend_repository_url>:latest"
backend_image  = "ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/coai-backend:latest"
frontend_image = "ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/coai-frontend:latest"

# App config
openai_api_key = "REDACTED"

# Database
db_username = "postgres"
db_password = "REDACTED"
db_name     = "codebase_onboarding"
```

2) Build and push images to ECR:

```bash
# Authenticate docker to ECR
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com

# Example: build and push backend
docker build -f apps/backend/Dockerfile -t coai-backend .
docker tag coai-backend:latest ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/coai-backend:latest
docker push ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/coai-backend:latest

# Example: build and push frontend
docker build -f apps/frontend/Dockerfile -t coai-frontend .
docker tag coai-frontend:latest ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/coai-frontend:latest
docker push ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/coai-frontend:latest
```

2) Init + apply:

```bash
terraform init
terraform apply
```

3) After apply, Terraform outputs:
- ALB URL (open in browser)
- ECR repo URLs
- RDS endpoint

## Notes
- This MVP runs ingestion inside the API task. For production, prefer a separate worker + queue.
- Repo storage is backed by EFS and mounted into the backend task at `/data` (`COAI_REPO_STORAGE_PATH=/data/repos`).
- Secrets (OpenAI key, DB password) are stored in AWS Secrets Manager and injected into the backend task at runtime.

# Terraform (AWS) – Scaffold

This directory is scaffolding for AWS infrastructure.

Intended target architecture (to implement in later phases):

- VPC + subnets
- ECS/Fargate services for `backend` and `frontend`
- RDS Postgres (optionally with pgvector)
- ECR repositories
- IAM roles/policies
- S3 + CloudFront (optional) for frontend assets

