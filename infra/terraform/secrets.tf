resource "random_password" "postgres" {
  length  = 32
  special = false
}

resource "random_password" "migrator" {
  length  = 32
  special = false
}

resource "random_password" "app_db" {
  length  = 32
  special = false
}

resource "random_password" "seed_admin" {
  length  = 32
  special = false
}

resource "tls_private_key" "token" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

locals {
  # for_each keys must not be sensitive, so the names are a plain list and the values are looked up.
  secret_names = toset([
    "POSTGRES_PASSWORD",
    "MIGRATOR_PASSWORD",
    "APP_DB_PASSWORD",
    "SEED_ADMIN_PASSWORD",
    "TOKEN_SIGNING_KEY",
  ])

  secret_values = {
    POSTGRES_PASSWORD   = random_password.postgres.result
    MIGRATOR_PASSWORD   = random_password.migrator.result
    APP_DB_PASSWORD     = random_password.app_db.result
    SEED_ADMIN_PASSWORD = random_password.seed_admin.result
    # One line for .env; PKCS#8 because jose.importPKCS8 rejects the SEC1 private_key_pem.
    TOKEN_SIGNING_KEY = base64encode(tls_private_key.token.private_key_pem_pkcs8)
  }

  settings = {
    APP_ENV            = "prod"
    LOG_LEVEL          = "info"
    HTTP_PORT          = "3000"
    PUBLIC_ORIGIN      = "https://${local.fqdn}"
    APP_DOMAIN         = local.fqdn
    DB_MAX_CONNS       = "10"
    ACCESS_TOKEN_TTL   = "1h"
    ECR_REPOSITORY_URL = aws_ecr_repository.app.repository_url
    LOG_GROUP          = aws_cloudwatch_log_group.app.name
    AWS_REGION         = data.aws_region.current.region
  }
}

resource "aws_ssm_parameter" "secret" {
  for_each = local.secret_names

  name  = "${local.ssm_prefix}/${each.key}"
  type  = "SecureString"
  value = local.secret_values[each.key]
}

resource "aws_ssm_parameter" "setting" {
  for_each = local.settings

  name  = "${local.ssm_prefix}/${each.key}"
  type  = "String"
  value = each.value
}
