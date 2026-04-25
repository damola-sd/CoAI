variable "aws_region" {
  type        = string
  description = "AWS region to deploy into."
}

variable "project_name" {
  type        = string
  description = "Name prefix for all resources."
  default     = "coai"
}

variable "backend_image" {
  type        = string
  description = "Full backend image URI (ECR), including tag."
}

variable "frontend_image" {
  type        = string
  description = "Full frontend image URI (ECR), including tag."
}

variable "openai_api_key" {
  type        = string
  description = "OpenAI API key for /qa/stream."
  sensitive   = true
}

variable "db_username" {
  type        = string
  description = "RDS master username."
  default     = "postgres"
}

variable "db_password" {
  type        = string
  description = "RDS master password."
  sensitive   = true
}

variable "db_name" {
  type        = string
  description = "Initial database name."
  default     = "codebase_onboarding"
}

variable "db_instance_class" {
  type        = string
  description = "RDS instance class."
  default     = "db.t4g.micro"
}

variable "db_allocated_storage_gb" {
  type        = number
  description = "RDS storage (GB)."
  default     = 20
}

variable "desired_count_backend" {
  type    = number
  default = 1
}

variable "desired_count_frontend" {
  type    = number
  default = 1
}

