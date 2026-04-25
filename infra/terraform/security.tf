resource "aws_security_group" "alb" {
  name        = "${local.name}-alb-sg"
  description = "ALB ingress"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${local.name}-alb-sg" })

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "ecs_tasks" {
  name        = "${local.name}-ecs-tasks-sg"
  description = "ECS tasks"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${local.name}-ecs-tasks-sg" })

  ingress {
    from_port       = 8000
    to_port         = 8000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  ingress {
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "rds" {
  name        = "${local.name}-rds-sg"
  description = "RDS Postgres"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${local.name}-rds-sg" })

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

