resource "aws_db_subnet_group" "this" {
  name       = "${local.name}-db-subnets"
  subnet_ids = [for s in aws_subnet.private : s.id]
  tags       = merge(local.tags, { Name = "${local.name}-db-subnets" })
}

resource "aws_db_instance" "postgres" {
  identifier              = "${local.name}-postgres"
  engine                  = "postgres"
  engine_version          = "16"
  instance_class          = var.db_instance_class
  allocated_storage       = var.db_allocated_storage_gb
  db_name                 = var.db_name
  username                = var.db_username
  password                = var.db_password
  db_subnet_group_name    = aws_db_subnet_group.this.name
  vpc_security_group_ids  = [aws_security_group.rds.id]
  publicly_accessible     = false
  multi_az                = false
  skip_final_snapshot     = true
  deletion_protection     = false
  backup_retention_period = 7

  tags = merge(local.tags, { Name = "${local.name}-postgres" })
}

