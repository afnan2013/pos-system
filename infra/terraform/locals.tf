data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

data "aws_availability_zones" "available" {
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  name = var.project_name
  fqdn = "${var.subdomain}.${var.root_domain}"

  tags = {
    Project     = var.project_name
    Environment = "prod"
    ManagedBy   = "terraform"
  }

  ssm_prefix = "/${var.project_name}/prod"
  az         = data.aws_availability_zones.available.names[0]
}
