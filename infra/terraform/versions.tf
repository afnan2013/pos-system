terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.74.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.4.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.tags
  }
}
