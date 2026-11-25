#!/usr/bin/env bash
set -euo pipefail

readonly project=pos
readonly ready_timeout_s=120

fail() {
  echo "deploy: $*" >&2
  exit 1
}

usage() {
  echo "usage: deploy.sh <40-character commit sha>" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage
readonly image_tag=$1
[[ $image_tag =~ ^[0-9a-f]{40}$ ]] || usage

# Terraform names the ECR repository and the SSM path after the same project_name.
[[ ${ECR_REPOSITORY_URL:-} =~ ^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/([a-z0-9]+(-[a-z0-9]+)*)$ ]] ||
  fail "ECR_REPOSITORY_URL must be set to the ECR repository URL, whose name is the Terraform project_name"
readonly ssm_path="/${BASH_REMATCH[1]}/prod"

deploy_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly deploy_dir
readonly compose_file="$deploy_dir/docker-compose.prod.yml"
readonly env_file="$deploy_dir/.env"

mountpoint -q /data || fail "/data is not a mounted volume; refusing to let Postgres write to the root disk"
[[ -d /data/postgres && -d /data/caddy ]] || fail "/data/postgres or /data/caddy is missing"
[[ -f $compose_file && -f $deploy_dir/Caddyfile ]] || fail "deploy files are missing from $deploy_dir"

compose() {
  docker compose --project-name "$project" --project-directory "$deploy_dir" \
    --env-file "$env_file" -f "$compose_file" "$@"
}

instance_region() {
  local token
  token=$(curl -fsS --max-time 5 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
    http://169.254.169.254/latest/api/token)
  curl -fsS --max-time 5 -H "X-aws-ec2-metadata-token: $token" \
    http://169.254.169.254/latest/meta-data/placement/region
}

param() {
  printf '%s' "$params" | jq -er --arg name "$1" \
    '.Parameters[] | select(.Name | split("/") | last == $name) | .Value'
}

region=${AWS_REGION:-$(instance_region)}
readonly region

echo "deploy: reading parameters under $ssm_path"
params=$(aws ssm get-parameters-by-path --region "$region" --path "$ssm_path" \
  --recursive --with-decryption --output json)

ecr_repository_url=$(param ECR_REPOSITORY_URL) || fail "ECR_REPOSITORY_URL is not set in SSM"
[[ $ecr_repository_url == "$ECR_REPOSITORY_URL" ]] ||
  fail "ECR_REPOSITORY_URL in SSM is $ecr_repository_url, but the deploy was started for $ECR_REPOSITORY_URL"
app_domain=$(param APP_DOMAIN) || fail "APP_DOMAIN is not set in SSM"
migrator_password=$(param MIGRATOR_PASSWORD) || fail "MIGRATOR_PASSWORD is not set in SSM"
app_db_password=$(param APP_DB_PASSWORD) || fail "APP_DB_PASSWORD is not set in SSM"
readonly ecr_repository_url app_domain

for password_name in migrator_password app_db_password; do
  [[ ${!password_name} =~ ^[A-Za-z0-9]+$ ]] ||
    fail "${password_name^^} must be letters and digits to fit in a database URL"
done

umask 077
env_tmp=$(mktemp "$deploy_dir/.env.XXXXXX")
trap 'rm -f "$env_tmp"' EXIT

# Single quotes make compose read each value literally, so a $ in a value is never interpolated.
printf '%s' "$params" | jq -r --arg q "'" '
  .Parameters
  | if length == 0 then error("no parameters found") else . end
  | .[]
  | (.Name | split("/") | last) as $name
  | if ($name | test("^[A-Z][A-Z0-9_]*$") | not) then error("parameter name \($name) is not a valid variable name")
    elif (.Value | contains($q) or contains("\n") or contains("\r")) then error("parameter \($name) has a quote or line break and cannot go in .env")
    else "\($name)=\($q)\(.Value)\($q)"
    end
' >"$env_tmp"
{
  printf "IMAGE_TAG='%s'\n" "$image_tag"
  printf "DATABASE_URL='postgres://pos_app:%s@db:5432/pos'\n" "$app_db_password"
  printf "MIGRATOR_DATABASE_URL='postgres://migrator:%s@db:5432/pos'\n" "$migrator_password"
} >>"$env_tmp"
unset params migrator_password app_db_password
chmod 600 "$env_tmp"
mv -f "$env_tmp" "$env_file"
trap - EXIT
echo "deploy: wrote $env_file"

previous_image=$(docker ps --filter "label=com.docker.compose.project=$project" \
  --filter "label=com.docker.compose.service=app" --format '{{.Image}}' | head -n 1)
readonly current_image="$ecr_repository_url:$image_tag"

echo "deploy: logging in to ${ecr_repository_url%%/*}"
aws ecr get-login-password --region "$region" |
  docker login --username AWS --password-stdin "${ecr_repository_url%%/*}"

CADDYFILE_SHA256=$(sha256sum "$deploy_dir/Caddyfile" | cut -d ' ' -f 1)
export CADDYFILE_SHA256

echo "deploy: pulling images for $image_tag"
compose pull --quiet
echo "deploy: starting the stack"
compose up -d --remove-orphans

echo "deploy: waiting up to ${ready_timeout_s}s for https://$app_domain/readyz"
deadline=$((SECONDS + ready_timeout_s))
until curl -fsS --max-time 5 -o /dev/null "https://$app_domain/readyz"; do
  if ((SECONDS >= deadline)); then
    compose ps >&2
    fail "https://$app_domain/readyz did not answer within ${ready_timeout_s}s"
  fi
  sleep 5
done
echo "deploy: $image_tag is ready"

while IFS= read -r image; do
  if [[ $image != "$current_image" && $image != "$previous_image" ]]; then
    docker image rm "$image" >/dev/null || echo "deploy: could not remove $image" >&2
  fi
done < <(docker image ls "$ecr_repository_url" --format '{{.Repository}}:{{.Tag}}' | grep -v ':<none>$' || true)
docker image prune -f >/dev/null
echo "deploy: done"
