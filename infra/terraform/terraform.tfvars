aws_region   = "eu-west-2"
project_name = "coai"

# Images (push to ECR first). Use the ECR repo URLs Terraform outputs:
# ecr_backend_repository_url  (then add :tag)
# ecr_frontend_repository_url (then add :tag)
backend_image  = "268836234966.dkr.ecr.eu-west-2.amazonaws.com/coai-backend:latest"
frontend_image = "268836234966.dkr.ecr.eu-west-2.amazonaws.com/coai-frontend:latest"

# Secrets (stored in AWS Secrets Manager by Terraform)
openai_api_key = "REDACTED"

# Database (Terraform creates the RDS instance using these)
db_username = "postgres"
db_password = "REDACTED"
db_name     = "codebase_onboarding"

# Optional sizing
db_instance_class       = "db.t4g.micro"
db_allocated_storage_gb = 20
desired_count_backend   = 1
desired_count_frontend  = 1