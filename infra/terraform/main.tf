locals {
  name = var.project_name
}

# Scaffold: later phases will introduce modules for
# - networking (vpc/subnets)
# - compute (ecs/fargate)
# - database (rds postgres)
# - container registry (ecr)

output "project_name" {
  value = local.name
}

