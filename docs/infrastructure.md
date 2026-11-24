# Infrastructure plan - multi-outlet POS

| Field | Value |
|---|---|
| Status | Terraform built (section 4); containers, deploy and workflows still to build, 2026-11-25 |
| Scope | AWS infrastructure (Terraform), container setup, and the GitHub Actions deploy path |
| Applies to | `infra/`, `deploy/`, `Dockerfile`, `docker-compose.yml`, `.github/workflows/` |

This document lists everything that has to be built to run the POS platform on AWS, file by file.
`infra/terraform/` exists and section 4 describes exactly what is in it.
The container, deploy and workflow files (sections 5 and 6) are not built yet; those sections are their target design.

## 1. Open items (fill these in before `terraform apply`)

Only one value is still open: `<AWS_PROFILE>`, the AWS CLI profile for the account that owns the state bucket, set in your shell when you run Terraform.
Every other value is committed, so `terraform.tfvars` is optional and only needed to override one.

| Value | Setting | Where it is set |
|---|---|---|
| State bucket | `afnan-s3-connector` | `infra/terraform/backend.tf` |
| State bucket region | `eu-west-1` | `infra/terraform/backend.tf` |
| Region for the POS resources | `ap-south-1` | `aws_region` default in `variables.tf` |
| Domain already hosted in Route53 | `afnanio.top` | `root_domain` default |
| POS subdomain | `pos`, so the app is at `https://pos.afnanio.top` | `subdomain` default |
| GitHub repository that may deploy | `afnan2013/pos-system` | `github_repo` default |
| Prefix for every resource name | `techzu-pos` | `project_name` default |
| GitHub OIDC provider | the account's existing one, looked up, never created | `iam_github.tf` |

## 2. The picture

```
Browser
  │ https://pos.afnanio.top
  ▼
Route53 A record ──► Elastic IP ──► EC2 t4g.small (Ubuntu 24.04, ARM)
                                     │
                                     │ docker compose (deploy/docker-compose.prod.yml)
                                     ├─ caddy    :80 :443  automatic HTTPS, reverse proxy to app:3000
                                     ├─ app      :3000     Express: /api/* + the React build (internal only)
                                     ├─ migrate  one-shot  migrations + permission sync, then exits
                                     └─ db       :5432     postgres:18 (internal only)
                                     │
                                     └─ /data  (separate EBS volume: Postgres data + Caddy certificates)

GitHub Actions ──(OIDC, no stored keys)──► ECR (image, deploy/ inside it) + SSM SendCommand ──► EC2
```

Key decisions behind it:

- One EC2 instance runs everything; Postgres is a container on the same host, not RDS.
- Caddy terminates HTTPS and renews the Let's Encrypt certificate by itself; there is no nginx and no API Gateway.
- Express serves both the API and the React build from one image, so there is one Dockerfile.
- The `deploy/` files travel inside that image, so there is no deploy bucket; the server copies them out of the image it pulls by commit SHA.
- No SSH: port 22 is closed, shell access and deploy commands go through AWS Systems Manager (SSM).
- GitHub Actions assumes an AWS role through OIDC (OpenID Connect), so no AWS keys are stored in GitHub.
- The server pulls images from ECR with its own IAM role, so no registry token lives on the box.
- Postgres data and Caddy certificates live on a separate EBS volume, so replacing the instance never loses data or forces a new certificate.
- There are no backups: this is a test deployment, and losing the data volume loses the data.
- Terraform is applied from your laptop; CI only checks formatting and validity.
- One environment (prod).

## 3. Repository layout for infrastructure

```
infra/
  terraform/
    versions.tf
    .terraform.lock.hcl
    backend.tf
    variables.tf
    terraform.tfvars.example
    locals.tf
    network.tf
    compute.tf
    cloud-init.yaml.tftpl
    dns.tf
    iam_instance.tf
    iam_github.tf
    ecr.tf
    secrets.tf
    observability.tf
    outputs.tf
deploy/
  docker-compose.prod.yml
  Caddyfile
  deploy.sh
  initdb/01-roles.sh
Dockerfile
.dockerignore
docker-compose.yml
.github/workflows/ci.yml
.github/workflows/deploy.yml
```

## 4. Terraform, file by file (`infra/terraform/`)

One flat root module, one file per concern, no child modules.
Validate it without touching the state bucket: `terraform init -backend=false`, then `terraform fmt -check -recursive` and `terraform validate`.

### `versions.tf` and `.terraform.lock.hcl`

- `required_version = ">= 1.11"`, because S3 native state locking (`use_lockfile`) is generally available from Terraform 1.11.
- Required providers, each pinned to a minor version: `hashicorp/aws` `~> 6.74.0`, `hashicorp/random` `~> 3.9.0`, `hashicorp/tls` `~> 4.4.0`.
- `provider "aws"` with `region = var.aws_region` and `default_tags` from `locals.tf`, so no resource repeats the common tags.
- `.terraform.lock.hcl` is committed and pins the exact provider versions, with checksums for Linux and macOS on both amd64 and arm64, so a CI runner never rewrites it.

### `backend.tf`

Uses an existing state bucket under this project's own key, so its state and lock never touch another project's.
There is no bootstrap stack; the bucket already exists.

```hcl
terraform {
  backend "s3" {
    bucket       = "afnan-s3-connector"
    key          = "techzu-pos/prod/terraform.tfstate"
    region       = "eu-west-1"
    encrypt      = true
    use_lockfile = true
  }
}
```

### `variables.tf` and `terraform.tfvars.example`

Eight variables, each with a committed default:

| Variable | Type | Default | Rule |
|---|---|---|---|
| `project_name` | string | `techzu-pos` | lowercase letters, digits and single inner hyphens, at most 50 characters, because the longest name built from it is the IAM role `<project_name>-github-deploy` and AWS caps role names at 64 |
| `aws_region` | string | `ap-south-1` | |
| `root_domain` | string | `afnanio.top` | a zone already hosted in Route53 |
| `subdomain` | string | `pos` | one DNS label: lowercase letters, digits and inner hyphens, at most 63 characters |
| `github_repo` | string | `afnan2013/pos-system` | `owner/name`; its `main` branch may assume the deploy role |
| `instance_type` | string | `t4g.small` | must be an ARM (Graviton) type, because the AMI and the image are ARM; not checked by a validation |
| `data_volume_size_gb` | number | `20` | |
| `log_retention_days` | number | `7` | |

`terraform.tfvars.example` lists all eight with their default values; copy it to `terraform.tfvars` only to override one.
`terraform.tfvars` itself is git-ignored, and so are `*.tfplan` files, because a saved plan can hold secrets.

### `locals.tf`

- Data sources shared by every file: `aws_caller_identity.current`, `aws_region.current`, and `aws_availability_zones.available` (zones that are available and need no opt-in).
- `name = var.project_name`, used as the prefix for every resource name.
- `fqdn = "${var.subdomain}.${var.root_domain}"`.
- `tags = { Project = var.project_name, Environment = "prod", ManagedBy = "terraform" }`, applied through `default_tags`; each resource adds only a `Name` tag.
- `ssm_prefix = "/${var.project_name}/prod"`, the path of every SSM parameter and the name of the log group.
- `az`, the first available zone; the subnet uses it and the data volume follows the subnet.

### `network.tf`

| Resource | Notes |
|---|---|
| `aws_vpc.main` | `10.20.0.0/16`, DNS support and hostnames on |
| `aws_subnet.public` | `10.20.1.0/24`, in `local.az`, `map_public_ip_on_launch = false` (the Elastic IP is the public address) |
| `aws_internet_gateway.main` | |
| `aws_route_table.public` + `aws_route_table_association.public` | default route to the internet gateway |
| `aws_security_group.app` | no inline rules |
| `aws_vpc_security_group_ingress_rule.http` and `.https` | TCP 80 and TCP 443 from `0.0.0.0/0`; port 80 is required for the Let's Encrypt HTTP challenge and the redirect to HTTPS |
| `aws_vpc_security_group_egress_rule.all` | all traffic out |

No port 22 rule, and no IPv6.

### `compute.tf`

| Resource | Notes |
|---|---|
| `data "aws_ssm_parameter" "ubuntu_ami"` | `/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id`, so no AMI ID is hard-coded; read through `insecure_value` so the plan shows the AMI ID instead of hiding it as sensitive |
| `aws_instance.app` | `var.instance_type`, public subnet, the security group, the instance profile, IMDSv2 required (`http_tokens = "required"`, hop limit 1), encrypted 12 GB gp3 root disk, `user_data` from `cloud-init.yaml.tftpl`; `lifecycle { ignore_changes = [ami, user_data] }` so a newer AMI or an edited template never replaces the server on a plan; depends on the route table association, because first boot downloads packages |
| `aws_ebs_volume.data` | gp3, `var.data_volume_size_gb`, encrypted, in `aws_subnet.public.availability_zone` so it always matches the instance, `lifecycle { prevent_destroy = true }` |
| `aws_volume_attachment.data` | device `/dev/sdf` (appears as an NVMe device inside the instance), `stop_instance_before_detaching = true`, because detaching a mounted volume from a running instance hangs |
| `aws_eip.public` | `domain = "vpc"`, allocated on its own, depends on the internet gateway |
| `aws_eip_association.public` | attaches the Elastic IP to the instance |

The Elastic IP does not depend on the instance, so the DNS record can be created as soon as the IP exists.
If the instance is ever replaced, the Elastic IP and the DNS record stay the same; only the association moves.
Terraform orders all of this from the references in one `terraform apply`.
There are no snapshots and no other backups of the data volume (see section 7 for replacing the instance safely).

### `cloud-init.yaml.tftpl`

Runs once, at first boot, in this order:

1. `write_files` writes `/etc/docker/daemon.json` with default log rotation (`max-size 10m`, `max-file 3`) before Docker is installed, so Docker starts with it.
2. Everything else is one bash script in `runcmd`, with `set -euo pipefail`; there is no `packages:` module, because it would run before the internet is reachable.
3. Waits up to 5 minutes for outbound internet, because the Elastic IP is associated only after the instance is running and there is no NAT.
4. Installs `ca-certificates`, `curl`, `jq` and `unzip`, then Docker Engine and the Compose plugin from Docker's official apt repository, and enables Docker.
   Every `apt-get` call retries downloads 5 times and waits up to 5 minutes for the package lock, which unattended upgrades hold at first boot.
5. Installs AWS CLI v2 from the official zip (`awscli-exe-linux-<arch>.zip`), because Ubuntu 24.04 has no `awscli` package in main; the version is not pinned.
6. Adds a 2 GB swap file as a safety margin for the 2 GB instance.
7. Waits up to 5 minutes for the data volume at `/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_<volume id without the dash>`, because the attachment can finish after boot starts.
8. Formats it as ext4 only when `blkid -p` reports no filesystem; any other `blkid` failure stops the script instead of formatting.
9. Mounts it at `/data` and adds it to `/etc/fstab` by UUID with `nofail`.
10. Creates `/data/postgres`, `/data/caddy` and `/opt/pos`.

The swap, fstab and mount steps check before they act, so running the script again is safe.
The template receives the data volume ID from `compute.tf` through `templatefile()`.

### `dns.tf`

| Resource | Notes |
|---|---|
| `data "aws_route53_zone" "root"` | looks up the existing public hosted zone for `var.root_domain` |
| `aws_route53_record.app` | `A` record for `local.fqdn` pointing at `aws_eip.public.public_ip`, TTL 300 |
| `aws_route53_record.caa` | `CAA 0 issue "letsencrypt.org"` on `local.fqdn`, TTL 300, so only Let's Encrypt can issue certificates for it |

Because of the CAA record, the Caddyfile names Let's Encrypt as its only certificate issuer; a fallback to another issuer would be refused.

### `iam_instance.tf` - what the server may do

| Resource | Notes |
|---|---|
| `aws_iam_role.instance` | `<project_name>-instance`, trust policy for `ec2.amazonaws.com` |
| `aws_iam_role_policy_attachment.ssm_core` | `AmazonSSMManagedInstanceCore` (SSM shell and run-command) |
| `data "aws_kms_alias" "ssm"` | the AWS-managed `alias/aws/ssm` key; it depends on the SecureString parameters, because AWS creates that key on the first SecureString write |
| `aws_iam_role_policy.instance` | inline policy `<project_name>-instance`, below |
| `aws_iam_instance_profile.instance` | `<project_name>-instance`, attached to `aws_instance.app` |

Inline policy statements, all built with `aws_iam_policy_document`:

- `EcrAuth`: `ecr:GetAuthorizationToken` on `*` (the action has no resource form).
- `EcrPull`: `ecr:BatchCheckLayerAvailability`, `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` on the POS repository only.
- `ParametersRead`: `ssm:GetParameter`, `ssm:GetParameters`, `ssm:GetParametersByPath` on `arn:aws:ssm:<region>:<account>:parameter/<project_name>/prod` and `.../prod/*`.
- `ParametersDecrypt`: `kms:Decrypt` on the `alias/aws/ssm` key only, with the condition `kms:ViaService = ssm.<region>.amazonaws.com`, so the server can decrypt SecureString parameters through SSM and nothing else.
- `LogsWrite`: `logs:CreateLogStream` and `logs:PutLogEvents` on the POS log group and on `<log group arn>:log-stream:*`.

The server has no S3 permissions.

### `iam_github.tf` - what GitHub Actions may do

| Resource | Notes |
|---|---|
| `data "aws_iam_openid_connect_provider" "github"` | looks up the account's existing provider for `https://token.actions.githubusercontent.com`; Terraform never creates it, because an account can hold only one and this one already exists |
| `aws_iam_role.github_deploy` | `<project_name>-github-deploy`, trust policy for that provider with conditions `aud = sts.amazonaws.com` and `sub = repo:<github_repo>:ref:refs/heads/main`, so only the `main` branch of this repository can assume it |
| `aws_iam_role_policy.github_deploy` | inline policy `<project_name>-github-deploy`, below |

Inline policy statements:

- `EcrAuth`: `ecr:GetAuthorizationToken` on `*`.
- `EcrPush`: `ecr:BatchCheckLayerAvailability`, `ecr:BatchGetImage`, `ecr:CompleteLayerUpload`, `ecr:InitiateLayerUpload`, `ecr:PutImage`, `ecr:UploadLayerPart` on the POS repository only.
- `DeployRun`: `ssm:SendCommand` on the instance ARN and on `arn:aws:ssm:<region>::document/AWS-RunShellScript`.
- `DeployWatch`: `ssm:GetCommandInvocation` and `ssm:ListCommandInvocations` on `*` (neither has a resource form).

GitHub Actions has no S3 permissions and no `ecr:DescribeImages`.

### `ecr.tf`

| Resource | Notes |
|---|---|
| `aws_ecr_repository.app` | name `<project_name>`, `image_tag_mutability = "IMMUTABLE"` (tags are commit SHAs), scan on push, AES256 encryption |
| `aws_ecr_lifecycle_policy.app` | keep the last 10 images, tagged or not |

A rollback can only go back to one of those 10 images; the image carries `deploy/` too, so nothing else limits it.

### `secrets.tf` - secrets and settings

Terraform writes 13 SSM parameters under `/<project_name>/prod/`.
The last part of each name is exactly the environment variable it becomes, because `deploy.sh` maps them by that suffix.
Both sets use `for_each` over plain names, so adding a setting is one line.

Five secrets, stored as `SecureString` with the AWS-managed `aws/ssm` key:

| Parameter | Source | Used by |
|---|---|---|
| `POSTGRES_PASSWORD` | `random_password`, 32 letters and digits | the Postgres superuser, only during first initialisation |
| `MIGRATOR_PASSWORD` | `random_password`, 32 letters and digits | the `migrator` role that owns the schema and runs migrations |
| `APP_DB_PASSWORD` | `random_password`, 32 letters and digits | the `pos_app` role the API uses (data access only, no DDL) |
| `SEED_ADMIN_PASSWORD` | `random_password`, 32 letters and digits | the first HQ admin created by the seed command |
| `TOKEN_SIGNING_KEY` | `tls_private_key` (ECDSA P-256), stored as `base64encode(private_key_pem_pkcs8)`: a PKCS#8 PEM, base64-encoded on one line | signs the ES256 access tokens |

Passwords have no symbols (`special = false`), so they fit in a `postgres://` URL and in `.env` without escaping.
The key is base64 because a multi-line PEM does not fit on one `.env` line, and PKCS#8 because the app imports it with `jose.importPKCS8`.

Eight settings, stored as plain `String`:

| Parameter | Value |
|---|---|
| `APP_ENV` | `prod` |
| `LOG_LEVEL` | `info` |
| `HTTP_PORT` | `3000` |
| `PUBLIC_ORIGIN` | `https://<fqdn>` |
| `APP_DOMAIN` | `<fqdn>` |
| `DB_MAX_CONNS` | `10` |
| `ACCESS_TOKEN_TTL` | `1h` |
| `ECR_REPOSITORY_URL` | the ECR repository URL |

The secret values also sit in Terraform state, which is why the state bucket must stay private and encrypted.

### `observability.tf`

| Resource | Notes |
|---|---|
| `aws_cloudwatch_log_group.app` | `/<project_name>/prod`, retention `var.log_retention_days`; containers ship logs here with Docker's `awslogs` driver, so pino's JSON lines are searchable in Logs Insights |
| `aws_cloudwatch_metric_alarm.instance_recover` | `<project_name>-instance-recover`, on `StatusCheckFailed_System` (Maximum, 2 periods of 60 seconds, threshold 1), action `arn:aws:automate:<region>:ec2:recover` |

### `outputs.tf`

Six outputs:

| Output | Copy it to |
|---|---|
| `app_url` | the README (`https://<fqdn>`) |
| `instance_id` | GitHub variable `EC2_INSTANCE_ID` |
| `ecr_repository_url` | GitHub variable `ECR_REPOSITORY_URL` |
| `github_deploy_role_arn` | GitHub variable `AWS_DEPLOY_ROLE_ARN` |
| `aws_region` | GitHub variable `AWS_REGION` |
| `ssm_session_command` | your notes: `aws ssm start-session --target <instance id> --region <region>` |

## 5. Containers

### `Dockerfile` (repository root)

Multi-stage, one image for the API and the web app:

1. `web-build`: `node:26-alpine`, `npm ci` and `npm run build` in `web/`, producing `web/dist`.
2. `api-build`: `node:26-alpine`, `npm ci`, pgtyped-generated code already committed, `tsc` to `api/dist`, then `npm prune --omit=dev`.
3. `runtime`: `node:26-alpine` with:
   - `NODE_ENV=production`
   - the compiled API, its production `node_modules`, the SQL migrations, and `web/dist` copied to `api/public`
   - runs as the non-root `node` user
   - `EXPOSE 3000`
   - `HEALTHCHECK` calling `/healthz`
   - default command starts the server; the same image also runs `migrate` and `seed`
   - the `deploy/` folder (`docker-compose.prod.yml`, `Caddyfile`, `deploy.sh`, `initdb/`) copied to the fixed path `/app/deploy`, so the server gets the deploy files of a release from its image

Node 26 is the current LTS line; pin the exact patch version in the `FROM` lines.

### `.dockerignore`

Excludes `node_modules`, `dist`, `.git`, `.env*`, `infra/`, `.adlc/` and test output, so the build context stays small and no secrets reach the image.
It must not exclude `deploy/`, because the image carries it.

### `docker-compose.yml` (repository root, for local use and reviewers)

- `db`: `postgres:18-alpine` with a named volume, `deploy/initdb` mounted into `/docker-entrypoint-initdb.d`, and a `pg_isready` healthcheck.
- `migrate`: builds from the `Dockerfile` and runs migrations and the permission sync; depends on `db` being healthy.
- `app`: builds from the `Dockerfile`, published on `localhost:3000`; depends on `migrate` finishing successfully.
- Reads a local `.env` (committed as `.env.example`).

A reviewer runs `docker compose up --build` and opens `http://localhost:3000`.

### `deploy/docker-compose.prod.yml`

Same services as the local file, with these differences:

- `app` and `migrate` use `image: ${ECR_REPOSITORY_URL}:${IMAGE_TAG}` instead of `build`.
- `caddy` (`caddy:2-alpine`) is added, publishing 80 and 443, with `./Caddyfile` mounted and `/data/caddy` for certificates.
- `db` stores data in the bind mount `/data/postgres` instead of a named volume.
- No service except Caddy publishes a port.
- Every service uses `logging: driver: awslogs` with `awslogs-group: /<project_name>/prod` and its own stream prefix.
- `restart: unless-stopped` on `caddy`, `app` and `db`.
- `migrate` depends on `db` being healthy, and `app` depends on `migrate` completing successfully, so a failed migration never starts a new app.

### `deploy/Caddyfile`

```
{$APP_DOMAIN} {
    tls {
        issuer acme {
            dir https://acme-v02.api.letsencrypt.org/directory
        }
    }
    encode zstd gzip
    header Strict-Transport-Security "max-age=31536000; includeSubDomains"
    reverse_proxy app:3000
}
```

`APP_DOMAIN` comes from the `.env` written by `deploy.sh`, which reads it from SSM.
The `tls` block makes Let's Encrypt the only issuer, because the CAA record in `dns.tf` refuses any other, and Caddy's defaults can fall back to ZeroSSL.
The `header` line adds `Strict-Transport-Security` (proposed), so browsers use HTTPS only for this domain.
The other security headers (`X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Content-Security-Policy`) are set by the app's `securityHeaders` middleware (proposed), so they are the same locally and in production.

### `deploy/initdb/01-roles.sh`

Runs only on the first start of an empty database:

- creates the `migrator` role that owns the `pos` schema
- creates the `pos_app` role with `SELECT, INSERT, UPDATE, DELETE` on tables and `USAGE` on sequences, granted through default privileges set by `migrator`
- sets the session timeouts on the roles with `ALTER ROLE`: `pos_app` gets `statement_timeout` 5s, `lock_timeout` 2s and `idle_in_transaction_session_timeout` 10s; `migrator` gets `lock_timeout` 5s

The full script is in `docs/database-design.md` (Database roles).

### `deploy/deploy.sh`

The deploy's SSM command gets `deploy.sh` onto the server before running it:

1. Logs Docker in to ECR with the instance role and pulls `<ECR_REPOSITORY_URL>:<sha>`.
2. Copies `/app/deploy` out of that image into `/opt/pos` with `docker create` and `docker cp`, then removes the stopped container.
3. Runs `/opt/pos/deploy.sh <sha>`.

So the compose file, Caddyfile and scripts always match the image they deploy, and the server never needs a git checkout or a bucket.

`deploy.sh` takes the commit SHA as its argument:

1. Fails fast if `/data` is not a mounted volume, so Postgres never writes to the root disk by mistake.
2. Reads every parameter under `/<project_name>/prod/`, secrets and settings alike, and writes `/opt/pos/.env` with mode `600`, naming each variable after the last part of the parameter name.
   It adds only `IMAGE_TAG` (its argument) and the two database URLs, built from the passwords.
3. Logs Docker in to ECR with the instance role.
4. Runs `docker compose -f docker-compose.prod.yml pull` first and only then `up -d --remove-orphans`, without stopping any service beforehand, so the old containers keep serving until the new images are on disk.
5. Polls `https://<fqdn>/readyz` for up to 2 minutes and exits non-zero if it never answers, which fails the GitHub Actions job.
6. Runs `docker image prune -f` to keep the disk clean.

Rollback is the same SSM command with an older SHA; it works for any of the last 10 images kept in ECR.

### Application environment (written to `.env` by `deploy.sh`)

| Variable | Value in prod | Comes from |
|---|---|---|
| `APP_ENV` | `prod` | SSM setting |
| `LOG_LEVEL` | `info` | SSM setting |
| `HTTP_PORT` | `3000` | SSM setting |
| `PUBLIC_ORIGIN` | `https://pos.afnanio.top` | SSM setting |
| `APP_DOMAIN` | `pos.afnanio.top`, read by the Caddyfile | SSM setting |
| `DB_MAX_CONNS` | `10` | SSM setting |
| `ACCESS_TOKEN_TTL` | `1h` | SSM setting |
| `ECR_REPOSITORY_URL` | the ECR repository URL, read by the compose file | SSM setting |
| `POSTGRES_PASSWORD` | 32 letters and digits | SSM secret |
| `MIGRATOR_PASSWORD` | 32 letters and digits | SSM secret |
| `APP_DB_PASSWORD` | 32 letters and digits | SSM secret |
| `SEED_ADMIN_PASSWORD` | 32 letters and digits, read by the seed command | SSM secret |
| `TOKEN_SIGNING_KEY` | a PKCS#8 PEM, base64-encoded on one line | SSM secret |
| `IMAGE_TAG` | the commit SHA | `deploy.sh` argument |
| `DATABASE_URL` | `postgres://pos_app:<APP_DB_PASSWORD>@db:5432/pos` | built by `deploy.sh` |
| `MIGRATOR_DATABASE_URL` | `postgres://migrator:<MIGRATOR_PASSWORD>@db:5432/pos` | built by `deploy.sh` |

Database connections never leave the host's Docker network, so they run without TLS (`sslmode=disable`) to the `db` host.
If the database ever moves off the host, TLS becomes required.

## 6. GitHub Actions

### Repository variables (Settings, then Secrets and variables, then Actions, then Variables)

`AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `ECR_REPOSITORY_URL`, `EC2_INSTANCE_ID`, each copied from the Terraform output of the same meaning (section 4, `outputs.tf`).
No AWS secrets are needed, because the workflow uses OIDC.

### `.github/workflows/ci.yml` (every pull request and push)

1. `npm ci` for `api/` and `web/`.
2. Lint and typecheck both.
3. Start a `postgres:18` service container, run `npm run migrate`, then `npm run db:generate`, and fail if the generated files differ from what is committed (the pgtyped drift check).
   This service container exists only for the drift check.
4. Run the API tests, including the concurrent sales tests; they start their own Postgres with testcontainers, the same way as locally, not the service container.
5. Build the web app.
6. `terraform fmt -check -recursive` and `terraform validate` (with `-backend=false`) in `infra/terraform`.

### `.github/workflows/deploy.yml` (push to `main`, after CI passes)

1. `permissions: id-token: write, contents: read`.
2. Runs on a native ARM runner (`ubuntu-24.04-arm`) so the image is built for the ARM instance without emulation.
3. `aws-actions/configure-aws-credentials` with `role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}`.
4. `aws-actions/amazon-ecr-login`.
5. `docker build` and push `${ECR_REPOSITORY_URL}:${GITHUB_SHA}`; the image includes `deploy/`.
6. `aws ssm send-command` with `AWS-RunShellScript` on `EC2_INSTANCE_ID`; the command pulls the image by SHA, copies `deploy/` out of it with `docker create` and `docker cp`, and runs `deploy.sh $GITHUB_SHA` (section 5, `deploy/deploy.sh`).
7. Waits for the command and prints its output; the job fails if `deploy.sh` fails.
8. `concurrency: deploy-prod` so two deploys never run at once.

## 7. First-time setup, in order

1. Nothing to fill in: every variable has a committed default (section 1); create `terraform.tfvars` only to override one.
2. Sign in to the right account: `aws sso login --profile <AWS_PROFILE>`, then `export AWS_PROFILE=<AWS_PROFILE>`.
3. In `infra/terraform`: `terraform init`, `terraform plan`, review it, then `terraform apply`.
   This one apply creates the Elastic IP, the instance and the DNS record in the right order.
4. Copy the four outputs into the GitHub repository variables listed in section 6.
5. Push a commit to `main`.
   The first deploy starts Caddy, which gets the Let's Encrypt certificate on its own.
6. Check `https://pos.afnanio.top/healthz` and `/readyz`.
   How the HQ admin and demo users get into prod is not decided yet (section 10).
7. Optional: run the `ssm_session_command` output, then `docker compose ps` in `/opt/pos` to look around.

Replacing the instance, for example to pick up a newer AMI or an edited `cloud-init.yaml.tftpl` (both are ignored on a normal plan):

1. Stop the stack over SSM so Postgres shuts down cleanly: `cd /opt/pos && docker compose -f docker-compose.prod.yml down`.
2. Run `terraform apply -replace=aws_instance.app`.
   Terraform stops the old instance before it detaches the data volume (`stop_instance_before_detaching`), then attaches the volume to the new one.
3. The new instance's first boot finds the existing filesystem, mounts it without formatting, and keeps the data and certificates.
4. Copy the new `instance_id` output into `EC2_INSTANCE_ID`, then deploy again.

Teardown: `terraform destroy` stops at the data volume because of `prevent_destroy`.
That is intentional; remove the lifecycle block only when you really want to delete the database.
There are no backups, so deleting the volume deletes the data for good.

## 8. Rough monthly cost

| Item | Approximate cost |
|---|---|
| t4g.small on demand | about $12-16, depending on region |
| 12 GB root + 20 GB data gp3 | about $3 |
| Public IPv4 (Elastic IP) | about $3.65 |
| ECR, SSM parameters, CloudWatch Logs | under $1 at this traffic |
| Route53 hosted zone | already paid for |
| **Total** | **about $20 per month** |

## 9. Out of scope for this deployment

These belong in the scaling plan of the architecture document, not in this build:

- RDS or Aurora instead of Postgres in a container.
- An Application Load Balancer, Auto Scaling group or ECS for more than one app server.
- CloudFront in front of the static web build.
- A WAF and rate limiting at the edge.
- Separate dev and prod environments.

## 10. Known follow-ups for the deploy REQ

The Terraform is built; these are open for the change that builds `deploy/`, the `Dockerfile` and the workflows.

- **Re-running a deploy:** ECR tags are immutable, so pushing the same SHA again can be rejected.
  Push a new commit instead, or skip the push when the tag exists (that needs `ecr:DescribeImages` on the deploy role).
- **Demo data in prod:** nothing runs `npm run seed` on the server, and no SSM parameter holds the outlet users' passwords.
  Decide whether seed runs once by hand over SSM, or prod has no demo data.
- **Postgres 18 data path:** the `postgres:18` image changed where its data lives under `/var/lib/postgresql`; check the image docs and name the container path in the prod compose file.
- **Database variables in prod compose:** `db` needs `POSTGRES_PASSWORD`, `MIGRATOR_PASSWORD`, `APP_DB_PASSWORD` and `POSTGRES_DB=pos` for `01-roles.sh`.
  That script runs only on an empty volume, so a password changed in SSM never reaches the database roles; rotation is manual.
- **Stop grace period:** the app drains for `SHUTDOWN_TIMEOUT` (10s), the same as Docker's default stop timeout, so set a longer `stop_grace_period` on `app`.
- **Rollback window:** a rollback can only reach one of the last 10 images ECR keeps.
- **Shellcheck in CI:** the rules require `shellcheck` on shell scripts, but no CI step runs it yet.
- **Backups:** none, by decision, because this is a test deployment.
  A real one would add EBS snapshots, a nightly `pg_dump`, or both.
- **Image pins:** only Node is pinned to a patch version; pin `postgres` and `caddy` exactly, and use the same Postgres tag locally and in prod.
- **`.dockerignore`:** add `.claude/`, as `.claude/rules/infra.md` asks.
- **AWS CLI version:** cloud-init installs the latest AWS CLI v2; pin a version if a release ever breaks `deploy.sh`.
- **Caddy issuer syntax:** check the `tls` block in the Caddyfile against the pinned Caddy version.
- **Frontend path:** `docs/frontend-engineering.md` calls `GET /v1/me` in one place where the rest of the docs say `/api/v1/me`.
