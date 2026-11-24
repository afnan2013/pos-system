output "app_url" {
  description = "Public URL of the POS; put it in the README."
  value       = "https://${local.fqdn}"
}

output "instance_id" {
  description = "App server instance ID; copy to the GitHub variable EC2_INSTANCE_ID."
  value       = aws_instance.app.id
}

output "ecr_repository_url" {
  description = "ECR repository for the app image; copy to the GitHub variable ECR_REPOSITORY_URL."
  value       = aws_ecr_repository.app.repository_url
}

output "github_deploy_role_arn" {
  description = "Role GitHub Actions assumes through OIDC; copy to the GitHub variable AWS_DEPLOY_ROLE_ARN."
  value       = aws_iam_role.github_deploy.arn
}

output "aws_region" {
  description = "Region of the POS resources; copy to the GitHub variable AWS_REGION."
  value       = data.aws_region.current.region
}

output "ssm_session_command" {
  description = "Shell command that opens an SSM session on the app server; keep it in your notes."
  value       = "aws ssm start-session --target ${aws_instance.app.id} --region ${data.aws_region.current.region}"
}
