resource "aws_cloudwatch_log_group" "app" {
  name              = local.ssm_prefix
  retention_in_days = var.log_retention_days
}
