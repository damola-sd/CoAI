output "alb_url" {
  description = "Base URL of the application load balancer."
  value       = "http://${aws_lb.this.dns_name}"
}

output "ecr_backend_repository_url" {
  value = aws_ecr_repository.backend.repository_url
}

output "ecr_frontend_repository_url" {
  value = aws_ecr_repository.frontend.repository_url
}

output "rds_endpoint" {
  value = aws_db_instance.postgres.address
}

