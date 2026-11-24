# Infrastructure plan - multi-outlet POS

| Field | Value |
|---|---|
| Status | draft, 2026-11-25 |
| Scope | AWS infrastructure (Terraform), container setup, and the GitHub Actions deploy path |
| Applies to | `infra/`, `deploy/`, `Dockerfile`, `docker-compose.yml`, `.github/workflows/` |

This document lists everything that has to be built to run the POS platform on AWS, file by file.
Nothing here exists yet; each section names the file it becomes.

## 1. Open items (fill these in before `terraform apply`)

| Placeholder | Meaning | Where it is used |
|---|---|---|
| `<STATE_BUCKET>` | An existing S3 bucket for Terraform state, shared with other projects | `infra/terraform/backend.tf` |
| `<STATE_REGION>` | That bucket's region | `infra/terraform/backend.tf` |
| `<AWS_PROFILE>` | The AWS CLI profile for the account that owns the bucket | your shell, when running Terraform |
| `<AWS_REGION>` | Region for the POS resources; pick one close to the reviewers | `terraform.tfvars` |
| `<ROOT_DOMAIN>` | The domain already hosted in Route53 | `terraform.tfvars` |
| `<SUBDOMAIN>` | The POS subdomain, for example `pos` | `terraform.tfvars` |
| `<GITHUB_OWNER>/<GITHUB_REPO>` | The GitHub repository that may deploy | `terraform.tfvars` |
| `<PROJECT_NAME>` | Prefix for every resource name; default `techzu-pos` | `terraform.tfvars` |

## 2. The picture

```
Browser
  │ https://<SUBDOMAIN>.<ROOT_DOMAIN>
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

GitHub Actions ──(OIDC, no stored keys)──► ECR (image) + S3 (deploy bundle) + SSM SendCommand ──► EC2
```

Key decisions behind it:

- One EC2 instance runs everything; Postgres is a container on the same host, not RDS.
- Caddy terminates HTTPS and renews the Let's Encrypt certificate by itself; there is no nginx and no API Gateway.
- Express serves both the API and the React build from one image, so there is one Dockerfile.
- No SSH: port 22 is closed, shell access and deploy commands go through AWS Systems Manager (SSM).
- GitHub Actions assumes an AWS role through OIDC, so no AWS keys are stored in GitHub.
- The server pulls images from ECR with its own IAM role, so no registry token lives on the box.
- Postgres data and Caddy certificates live on a separate EBS volume, so replacing the instance never loses data or forces a new certificate.
- Terraform is applied from your laptop; CI only checks formatting and validity.
- One environment (prod).

## 3. Repository layout for infrastructure

```
infra/
  terraform/
    versions.tf
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
    deploy_bucket.tf
    secrets.tf
    observability.tf
    backups.tf
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

### `versions.tf`

- `required_version` for Terraform 1.10 or newer (needed for S3 native locking).
- Required providers: `hashicorp/aws`, `hashicorp/random`, `hashicorp/tls`, each pinned to a minor version.
- `provider "aws"` with `region = var.aws_region` and `default_tags` from `locals.tf`.

### `backend.tf`

Uses an existing state bucket under this project's own key, so its state and lock never touch another project's.
There is no bootstrap stack; the bucket already exists.

```hcl
terraform {
  backend "s3" {
    bucket       = "<STATE_BUCKET>"
    key          = "techzu-pos/prod/terraform.tfstate"
    region       = "<STATE_REGION>"
    encrypt      = true
    use_lockfile = true
  }
}
```

### `variables.tf` and `terraform.tfvars.example`

| Variable | Type | Default |
|---|---|---|
| `project_name` | string | `techzu-pos` |
| `aws_region` | string | none |
| `root_domain` | string | none |
| `subdomain` | string | `pos` |
| `github_repo` | string (`owner/name`) | none |
| `instance_type` | string | `t4g.small` |
| `data_volume_size_gb` | number | `20` |
| `log_retention_days` | number | `14` |
| `snapshot_retention_count` | number | `7` |
| `create_github_oidc_provider` | bool | `true` (set `false` if the account already has one) |

`terraform.tfvars` itself is git-ignored; only the `.example` is committed.

### `locals.tf`

- `name = var.project_name`, used as the prefix for every resource name.
- `fqdn = "${var.subdomain}.${var.root_domain}"`.
- `tags = { Project = var.project_name, Environment = "prod", ManagedBy = "terraform" }`.

### `network.tf`

| Resource | Notes |
|---|---|
| `aws_vpc.main` | `10.20.0.0/16`, DNS support and hostnames on |
| `aws_subnet.public` | `10.20.1.0/24`, one availability zone, `map_public_ip_on_launch = false` (the Elastic IP is the public address) |
| `aws_internet_gateway.main` | |
| `aws_route_table.public` + `aws_route_table_association.public` | default route to the internet gateway |
| `aws_security_group.app` | no inline rules |
| `aws_vpc_security_group_ingress_rule` x2 | TCP 80 and TCP 443 from `0.0.0.0/0`; port 80 is required for the Let's Encrypt HTTP challenge and the redirect to HTTPS |
| `aws_vpc_security_group_egress_rule` | all traffic out |

No port 22 rule.

### `compute.tf`

| Resource | Notes |
|---|---|
| `data "aws_ssm_parameter" "ubuntu_ami"` | `/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id`, so no AMI ID is hard-coded |
| `aws_instance.app` | `t4g.small`, public subnet, the security group, the instance profile, IMDSv2 required (`http_tokens = "required"`), encrypted 12 GB gp3 root disk, `user_data` from `cloud-init.yaml.tftpl`; `lifecycle { ignore_changes = [ami, user_data] }` so a newer AMI does not replace the server on every plan |
| `aws_ebs_volume.data` | gp3, `var.data_volume_size_gb`, encrypted, same availability zone, tag `Backup = "daily"` for the snapshot policy, `lifecycle { prevent_destroy = true }` |
| `aws_volume_attachment.data` | device `/dev/sdf` (appears as an NVMe device inside the instance) |
| `aws_eip.public` | `domain = "vpc"`, allocated on its own |
| `aws_eip_association.public` | attaches the Elastic IP to the instance |

The Elastic IP does not depend on the instance, so the DNS record can be created as soon as the IP exists.
If the instance is ever replaced, the Elastic IP and the DNS record stay the same; only the association moves.
Terraform orders all of this from the references in one `terraform apply`.

### `cloud-init.yaml.tftpl`

Runs once, at first boot:

1. Installs Docker Engine and the Compose plugin from Docker's official apt repository, plus `awscli` and `jq`.
2. Adds a 2 GB swap file as a safety margin for the 2 GB instance.
3. Waits (up to 5 minutes) for the data volume to appear at `/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_<volume id without the dash>`, because the attachment can finish after boot starts.
4. Formats it as ext4 only if it has no filesystem yet, mounts it at `/data`, and adds it to `/etc/fstab` by UUID with `nofail`.
5. Creates `/data/postgres`, `/data/caddy` and `/opt/pos`.
6. Writes `/etc/docker/daemon.json` with default log rotation (`max-size 10m`, `max-file 3`) for anything not sent to CloudWatch.

The template receives the data volume ID from `compute.tf` through `templatefile()`.

### `dns.tf`

| Resource | Notes |
|---|---|
| `data "aws_route53_zone" "root"` | looks up the existing hosted zone for `var.root_domain` |
| `aws_route53_record.app` | `A` record for `local.fqdn` pointing at `aws_eip.public.public_ip`, TTL 300 |
| `aws_route53_record.caa` (optional) | `CAA 0 issue "letsencrypt.org"` on `local.fqdn`, so only Let's Encrypt can issue certificates for it |

### `iam_instance.tf` - what the server may do

| Resource | Notes |
|---|---|
| `aws_iam_role.instance` | trust policy for `ec2.amazonaws.com` |
| `aws_iam_role_policy_attachment.ssm_core` | `AmazonSSMManagedInstanceCore` (SSM shell and run-command) |
| `aws_iam_role_policy.instance` | inline policy, below |
| `aws_iam_instance_profile.instance` | attached to `aws_instance.app` |

Inline policy statements:

- ECR pull: `ecr:GetAuthorizationToken` on `*`; `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer`, `ecr:BatchCheckLayerAvailability` on the POS repository only.
- Deploy bundle: `s3:GetObject` on `arn:aws:s3:::<deploy bucket>/releases/*`.
- Secrets: `ssm:GetParametersByPath` and `ssm:GetParameter` on `/<project_name>/prod/*`, and `kms:Decrypt` with the condition `kms:ViaService = ssm.<region>.amazonaws.com`.
- Logs: `logs:CreateLogStream` and `logs:PutLogEvents` on the POS log group.

### `iam_github.tf` - what GitHub Actions may do

| Resource | Notes |
|---|---|
| `aws_iam_openid_connect_provider.github` | URL `https://token.actions.githubusercontent.com`, client ID `sts.amazonaws.com`; created only when `var.create_github_oidc_provider` is true, otherwise read with a `data` block (an account can hold only one) |
| `aws_iam_role.github_deploy` | trust policy for that provider with conditions `aud = sts.amazonaws.com` and `sub = repo:<GITHUB_OWNER>/<GITHUB_REPO>:ref:refs/heads/main`, so only the `main` branch of this repository can assume it |
| `aws_iam_role_policy.github_deploy` | inline policy, below |

Inline policy statements:

- ECR push: `ecr:GetAuthorizationToken` on `*`; `ecr:BatchCheckLayerAvailability`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, `ecr:PutImage`, `ecr:BatchGetImage` on the POS repository only.
- Deploy bundle: `s3:PutObject` on `arn:aws:s3:::<deploy bucket>/releases/*`.
- Run the deploy: `ssm:SendCommand` on the instance ARN and on `arn:aws:ssm:<region>::document/AWS-RunShellScript`; `ssm:GetCommandInvocation` and `ssm:ListCommandInvocations` on `*`.

### `ecr.tf`

| Resource | Notes |
|---|---|
| `aws_ecr_repository.app` | name `<project_name>`, `image_tag_mutability = "IMMUTABLE"` (tags are commit SHAs), scan on push |
| `aws_ecr_lifecycle_policy.app` | keep the last 10 images |

### `deploy_bucket.tf`

| Resource | Notes |
|---|---|
| `aws_s3_bucket.deploy` | name `<project_name>-deploy-<account id>` |
| `aws_s3_bucket_public_access_block.deploy` | all four blocks on |
| `aws_s3_bucket_server_side_encryption_configuration.deploy` | SSE-S3 |
| `aws_s3_bucket_lifecycle_configuration.deploy` | expire `releases/` objects after 30 days |

CI uploads `deploy/docker-compose.prod.yml`, `deploy/Caddyfile`, `deploy/deploy.sh` and `deploy/initdb/` to `releases/<commit sha>/` for every deploy.
This way the server never needs a git checkout, and changing the compose file never means replacing the instance.

### `secrets.tf`

All values are generated by Terraform and stored as SSM SecureString parameters under `/<project_name>/prod/`.

| Parameter | Source | Used by |
|---|---|---|
| `POSTGRES_PASSWORD` | `random_password` (32 chars) | the Postgres superuser, only during first initialisation |
| `MIGRATOR_PASSWORD` | `random_password` | the `migrator` role that owns the schema and runs migrations |
| `APP_DB_PASSWORD` | `random_password` | the `pos_app` role the API uses (data access only, no DDL) |
| `TOKEN_SIGNING_KEY` | `tls_private_key` (ECDSA P-256), stored as PEM | signs the ES256 access tokens |
| `SEED_ADMIN_PASSWORD` | `random_password` | the first HQ admin created by the seed command |

The values also sit in Terraform state, which is why the state bucket must stay private and encrypted.

### `observability.tf`

| Resource | Notes |
|---|---|
| `aws_cloudwatch_log_group.app` | `/<project_name>/prod`, retention `var.log_retention_days`; containers ship logs here with Docker's `awslogs` driver, so pino's JSON lines are searchable in Logs Insights |
| `aws_cloudwatch_metric_alarm.instance_recover` | on `StatusCheckFailed_System` for 2 minutes, action `arn:aws:automate:<region>:ec2:recover` |

### `backups.tf`

| Resource | Notes |
|---|---|
| `aws_iam_role.dlm` + `aws_iam_role_policy_attachment.dlm` | `AWSDataLifecycleManagerServiceRole` |
| `aws_dlm_lifecycle_policy.data` | targets volumes tagged `Backup = "daily"`, one snapshot every 24 hours, keeps `var.snapshot_retention_count` |

### `outputs.tf`

| Output | Copy it to |
|---|---|
| `app_url` | the README |
| `instance_id` | GitHub variable `EC2_INSTANCE_ID` |
| `ecr_repository_url` | GitHub variable `ECR_REPOSITORY_URL` |
| `github_deploy_role_arn` | GitHub variable `AWS_DEPLOY_ROLE_ARN` |
| `deploy_bucket` | GitHub variable `DEPLOY_BUCKET` |
| `aws_region` | GitHub variable `AWS_REGION` |
| `ssm_session_command` | your notes: `aws ssm start-session --target <instance id>` |

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

Node 26 is the current LTS line; pin the exact patch version in the `FROM` lines.

### `.dockerignore`

Excludes `node_modules`, `dist`, `.git`, `.env*`, `infra/`, `.adlc/` and test output, so the build context stays small and no secrets reach the image.

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
    encode zstd gzip
    header Strict-Transport-Security "max-age=31536000; includeSubDomains"
    reverse_proxy app:3000
}
```

`APP_DOMAIN` comes from the `.env` written by `deploy.sh`.
The `header` line adds `Strict-Transport-Security` (proposed), so browsers use HTTPS only for this domain.
The other security headers (`X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Content-Security-Policy`) are set by the app's `securityHeaders` middleware (proposed), so they are the same locally and in production.

### `deploy/initdb/01-roles.sh`

Runs only on the first start of an empty database:

- creates the `migrator` role that owns the `pos` schema
- creates the `pos_app` role with `SELECT, INSERT, UPDATE, DELETE` on tables and `USAGE` on sequences, granted through default privileges set by `migrator`
- sets the session timeouts on the roles with `ALTER ROLE`: `pos_app` gets `statement_timeout` 5s, `lock_timeout` 2s and `idle_in_transaction_session_timeout` 10s; `migrator` gets `lock_timeout` 5s

The full script is in `docs/database-design.md` (Database roles).

### `deploy/deploy.sh`

Run on the instance by SSM with the commit SHA as its argument:

1. Fails fast if `/data` is not a mounted volume, so Postgres never writes to the root disk by mistake.
2. Downloads `releases/<sha>/` from the deploy bucket into `/opt/pos`.
3. Reads every parameter under `/<project_name>/prod/` and writes `/opt/pos/.env` with mode `600`, adding `IMAGE_TAG`, `ECR_REPOSITORY_URL`, `APP_DOMAIN` and the database URLs.
4. Logs Docker in to ECR with the instance role.
5. Runs `docker compose -f docker-compose.prod.yml pull`, then `up -d --remove-orphans`.
6. Polls `https://<fqdn>/readyz` for up to 2 minutes and exits non-zero if it never answers, which fails the GitHub Actions job.
7. Runs `docker image prune -f` to keep the disk clean.

### Application environment (written to `.env` by `deploy.sh`)

| Variable | Value in prod |
|---|---|
| `APP_ENV` | `prod` |
| `LOG_LEVEL` | `info` |
| `HTTP_PORT` | `3000` |
| `PUBLIC_ORIGIN` | `https://<SUBDOMAIN>.<ROOT_DOMAIN>` |
| `DATABASE_URL` | `postgres://pos_app:<APP_DB_PASSWORD>@db:5432/pos` |
| `MIGRATOR_DATABASE_URL` | `postgres://migrator:<MIGRATOR_PASSWORD>@db:5432/pos` |
| `DB_MAX_CONNS` | `10` |
| `TOKEN_SIGNING_KEY` | the PEM from SSM |
| `ACCESS_TOKEN_TTL` | `1h` |

Database connections never leave the host's Docker network, so they run without TLS (`sslmode=disable`) to the `db` host.
If the database ever moves off the host, TLS becomes required.

## 6. GitHub Actions

### Repository variables (Settings, then Secrets and variables, then Actions, then Variables)

`AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `ECR_REPOSITORY_URL`, `DEPLOY_BUCKET`, `EC2_INSTANCE_ID`.
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
5. `docker build` and push `${ECR_REPOSITORY_URL}:${GITHUB_SHA}`.
6. `aws s3 cp deploy/ s3://$DEPLOY_BUCKET/releases/$GITHUB_SHA/ --recursive`.
7. `aws ssm send-command` with `AWS-RunShellScript` that downloads and runs `deploy.sh $GITHUB_SHA`.
8. Waits for the command and prints its output; the job fails if `deploy.sh` fails.
9. `concurrency: deploy-prod` so two deploys never run at once.

## 7. First-time setup, in order

1. Fill in the placeholders from section 1 and copy `terraform.tfvars.example` to `terraform.tfvars`.
2. Sign in to the right account: `aws sso login --profile <AWS_PROFILE>`, then `export AWS_PROFILE=<AWS_PROFILE>`.
3. In `infra/terraform`: `terraform init`, `terraform plan`, review it, then `terraform apply`.
   This one apply creates the Elastic IP, the instance and the DNS record in the right order.
4. Copy the outputs into the GitHub repository variables listed in section 6.
5. Push to `main` (or re-run the deploy workflow).
   The first deploy starts Caddy, which gets the Let's Encrypt certificate on its own.
6. Check `https://<SUBDOMAIN>.<ROOT_DOMAIN>/healthz` and `/readyz`, then sign in with the seeded HQ admin.
7. Optional: `aws ssm start-session --target <instance id>` and `docker compose ps` to look around.

Teardown: `terraform destroy` stops at the data volume because of `prevent_destroy`.
That is intentional; remove the lifecycle block only when you really want to delete the database.

## 8. Rough monthly cost

| Item | Approximate cost |
|---|---|
| t4g.small on demand | about $12-16, depending on region |
| 12 GB root + 20 GB data gp3 | about $3 |
| Public IPv4 (Elastic IP) | about $3.65 |
| EBS snapshots, ECR, S3, CloudWatch Logs | under $1 at this traffic |
| Route53 hosted zone | already paid for |
| **Total** | **about $20 per month** |

## 9. Out of scope for this deployment

These belong in the scaling plan of the architecture document, not in this build:

- RDS or Aurora instead of Postgres in a container.
- An Application Load Balancer, Auto Scaling group or ECS for more than one app server.
- CloudFront in front of the static web build.
- A WAF and rate limiting at the edge.
- Separate dev and prod environments.
