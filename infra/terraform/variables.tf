variable "project_name" {
  description = "Prefix for every resource name and the SSM parameter path."
  type        = string
  default     = "techzu-pos"

  validation {
    condition     = length(var.project_name) <= 50 && can(regex("^[a-z0-9]+(-[a-z0-9]+)*$", var.project_name))
    error_message = "project_name must be lowercase letters, digits and single inner hyphens, at most 50 characters (it prefixes the IAM role <project_name>-github-deploy, which AWS caps at 64)."
  }
}

variable "aws_region" {
  description = "AWS region for the POS resources."
  type        = string
  default     = "ap-south-1"
}

variable "root_domain" {
  description = "Domain already hosted in Route53."
  type        = string
  default     = "afnanio.top"
}

variable "subdomain" {
  description = "Subdomain the POS is served on, under root_domain."
  type        = string
  default     = "pos"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.subdomain))
    error_message = "subdomain must be one DNS label: lowercase letters, digits and inner hyphens, at most 63 characters."
  }
}

variable "github_repo" {
  description = "GitHub repository whose main branch may assume the deploy role, as owner/name."
  type        = string
  default     = "afnan2013/pos-system"

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.github_repo))
    error_message = "github_repo must be owner/name, for example my-org/pos-system."
  }
}

variable "instance_type" {
  description = "EC2 instance type; must be an ARM (Graviton) type."
  type        = string
  default     = "t4g.small"
}

variable "data_volume_size_gb" {
  description = "Size in GiB of the EBS volume mounted at /data."
  type        = number
  default     = 20
}

variable "log_retention_days" {
  description = "Days CloudWatch keeps the application logs."
  type        = number
  default     = 7
}
