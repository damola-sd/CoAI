resource "aws_secretsmanager_secret" "openai_api_key" {
  name = "${local.name}/openai_api_key"
  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "openai_api_key" {
  secret_id     = aws_secretsmanager_secret.openai_api_key.id
  secret_string = var.openai_api_key
}

resource "aws_secretsmanager_secret" "db_password" {
  name = "${local.name}/db_password"
  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "db_password" {
  secret_id     = aws_secretsmanager_secret.db_password.id
  secret_string = var.db_password
}

data "aws_iam_policy_document" "secrets_read" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.openai_api_key.arn,
      aws_secretsmanager_secret.db_password.arn,
    ]
  }
}

resource "aws_iam_policy" "secrets_read" {
  name   = "${local.name}-secrets-read"
  policy = data.aws_iam_policy_document.secrets_read.json
  tags   = local.tags
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution_secrets" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = aws_iam_policy.secrets_read.arn
}

