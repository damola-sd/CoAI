resource "aws_ecs_cluster" "this" {
  name = "${local.name}-cluster"
  tags = local.tags
}

resource "aws_iam_role" "ecs_task_execution" {
  name               = "${local.name}-ecs-task-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_execution_assume.json
  tags               = local.tags
}

resource "aws_iam_role" "ecs_task" {
  name               = "${local.name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_execution_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "ecs_task_execution_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_cloudwatch_log_group" "backend" {
  name              = "/ecs/${local.name}/backend"
  retention_in_days = 14
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "frontend" {
  name              = "/ecs/${local.name}/frontend"
  retention_in_days = 14
  tags              = local.tags
}

resource "aws_ecs_task_definition" "backend" {
  family                   = "${local.name}-backend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "backend"
      image     = var.backend_image
      essential = true
      portMappings = [
        { containerPort = 8000, hostPort = 8000, protocol = "tcp" }
      ]
      environment = [
        { name = "COAI_ENVIRONMENT", value = "aws" },
        { name = "COAI_EMBEDDINGS_PROVIDER", value = "openai" },
        { name = "COAI_OPENAI_MODEL", value = "gpt-4.1-mini" },
        { name = "COAI_OPENAI_EMBEDDINGS_MODEL", value = "text-embedding-3-small" },
        { name = "COAI_REPO_STORAGE_PATH", value = "/data/repos" },
      ]
      secrets = [
        { name = "COAI_OPENAI_API_KEY", valueFrom = aws_secretsmanager_secret.openai_api_key.arn },
        { name = "DB_PASSWORD", valueFrom = aws_secretsmanager_secret.db_password.arn },
      ]
      command = [
        "sh",
        "-c",
        "export COAI_DATABASE_URL=\"postgresql+asyncpg://${var.db_username}:$DB_PASSWORD@${aws_db_instance.postgres.address}:5432/${var.db_name}\" && uv run alembic upgrade head && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000"
      ]
      mountPoints = [
        { sourceVolume = "repo_data", containerPath = "/data", readOnly = false }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.backend.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "ecs"
        }
      }
    }
  ])

  volume {
    name = "repo_data"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.repo_data.id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.repo_data.id
        iam             = "ENABLED"
      }
    }
  }
}

resource "aws_ecs_task_definition" "frontend" {
  family                   = "${local.name}-frontend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "frontend"
      image     = var.frontend_image
      essential = true
      portMappings = [
        { containerPort = 3000, hostPort = 3000, protocol = "tcp" }
      ]
      environment = [
        # For browser calls: use ALB DNS name (http). Prefer HTTPS + domain in real env.
        { name = "NEXT_PUBLIC_API_BASE_URL", value = "http://${aws_lb.this.dns_name}" }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.frontend.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "ecs"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "backend" {
  name            = "${local.name}-backend"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.backend.arn
  desired_count   = var.desired_count_backend
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = [for s in aws_subnet.private : s.id]
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.backend.arn
    container_name   = "backend"
    container_port   = 8000
  }

  depends_on = [aws_lb_listener.http]
  tags       = local.tags
}

resource "aws_ecs_service" "frontend" {
  name            = "${local.name}-frontend"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.frontend.arn
  desired_count   = var.desired_count_frontend
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = [for s in aws_subnet.private : s.id]
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.frontend.arn
    container_name   = "frontend"
    container_port   = 3000
  }

  depends_on = [aws_lb_listener.http]
  tags       = local.tags
}

