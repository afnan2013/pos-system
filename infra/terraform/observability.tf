resource "aws_cloudwatch_log_group" "app" {
  name              = local.ssm_prefix
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_metric_alarm" "instance_recover" {
  alarm_name          = "${local.name}-instance-recover"
  alarm_description   = "Recover the app instance onto healthy hardware when the AWS system status check fails."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_System"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  alarm_actions       = ["arn:aws:automate:${data.aws_region.current.region}:ec2:recover"]

  dimensions = {
    InstanceId = aws_instance.app.id
  }
}
