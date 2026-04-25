resource "aws_security_group" "efs" {
  name        = "${local.name}-efs-sg"
  description = "EFS NFS access from ECS tasks"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${local.name}-efs-sg" })

  ingress {
    from_port       = 2049
    to_port         = 2049
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

resource "aws_efs_file_system" "repo_data" {
  creation_token = "${local.name}-repo-data"
  encrypted      = true
}

resource "aws_efs_mount_target" "repo_data" {
  count           = length(aws_subnet.private)
  file_system_id  = aws_efs_file_system.repo_data.id
  subnet_id       = aws_subnet.private[count.index].id
  security_groups = [aws_security_group.efs.id]
}

resource "aws_efs_access_point" "repo_data" {
  file_system_id = aws_efs_file_system.repo_data.id

  posix_user {
    gid = 1000
    uid = 1000
  }

  root_directory {
    path = "/repo-data"
    creation_info {
      owner_gid   = 1000
      owner_uid   = 1000
      permissions = "0755"
    }
  }

}

data "aws_iam_policy_document" "efs_client" {
  statement {
    actions = [
      "elasticfilesystem:ClientMount",
      "elasticfilesystem:ClientWrite",
      "elasticfilesystem:ClientRootAccess",
    ]
    resources = [aws_efs_file_system.repo_data.arn]

    condition {
      test     = "StringEquals"
      variable = "elasticfilesystem:AccessPointArn"
      values   = [aws_efs_access_point.repo_data.arn]
    }
  }
}

resource "aws_iam_policy" "efs_client" {
  name   = "${local.name}-efs-client"
  policy = data.aws_iam_policy_document.efs_client.json
  tags   = local.tags
}

resource "aws_iam_role_policy_attachment" "ecs_task_efs" {
  role       = aws_iam_role.ecs_task.name
  policy_arn = aws_iam_policy.efs_client.arn
}

