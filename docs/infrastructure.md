# Infrastructure plan - multi-outlet POS

| Field | Value |
|---|---|
| Status | Built: Terraform (section 4), containers and deploy files (section 5), workflows (section 6); first deploy pending, 2026-11-25 |
| Scope | AWS infrastructure (Terraform), container setup, and the GitHub Actions deploy path |
| Applies to | `infra/`, `deploy/`, `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `docker-compose.dev.yml`, `.env.example`, `.github/workflows/` |

This document lists everything that has to be built to run the POS platform on AWS, file by file.
Every file it names exists, and sections 4 to 6 describe them as built.
Deploys start only by hand, from the GitHub Actions page; a push or a merge to `main` never deploys.

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
| Its numeric owner and repository IDs | `27606729` and `1470777261`, part of the OIDC subject GitHub sends | `github_owner_id` and `github_repo_id` defaults |
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
                                     └─ db       :5432     postgres:18.7-alpine (internal only)
                                     │
                                     └─ /data  (separate EBS volume: Postgres data + Caddy certificates)

GitHub Actions, started by hand ──(OIDC, no stored keys)──► ECR (image, deploy/ inside it) + SSM SendCommand ──► EC2
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
- Deploys are started by hand from the GitHub Actions page, on `main` only; nothing deploys on a push or a merge.
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
.gitattributes
.env.example
docker-compose.yml
docker-compose.dev.yml
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

Ten variables, each with a committed default:

| Variable | Type | Default | Rule |
|---|---|---|---|
| `project_name` | string | `techzu-pos` | lowercase letters, digits and single inner hyphens, at most 50 characters, because the longest name built from it is the IAM role `<project_name>-github-deploy` and AWS caps role names at 64 |
| `aws_region` | string | `ap-south-1` | |
| `root_domain` | string | `afnanio.top` | a zone already hosted in Route53 |
| `subdomain` | string | `pos` | one DNS label: lowercase letters, digits and inner hyphens, at most 63 characters |
| `github_repo` | string | `afnan2013/pos-system` | `owner/name`; its `main` branch may assume the deploy role |
| `github_owner_id` | string | `27606729` | digits only; the owner's numeric GitHub ID |
| `github_repo_id` | string | `1470777261` | digits only; the repository's numeric GitHub ID |
| `instance_type` | string | `t4g.small` | must be an ARM (Graviton) type, because the AMI and the image are ARM; not checked by a validation |
| `data_volume_size_gb` | number | `20` | |
| `log_retention_days` | number | `7` | |

`terraform.tfvars.example` lists all ten with their default values; copy it to `terraform.tfvars` only to override one.
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
| `aws_iam_role.github_deploy` | `<project_name>-github-deploy`, trust policy for that provider with conditions `aud = sts.amazonaws.com` and `sub = repo:<owner>@<github_owner_id>/<name>@<github_repo_id>:ref:refs/heads/main` (today `repo:afnan2013@27606729/pos-system@1470777261:ref:refs/heads/main`), so only the `main` branch of this repository can assume it |
| `aws_iam_role_policy.github_deploy` | inline policy `<project_name>-github-deploy`, below |

Inline policy statements:

- `EcrAuth`: `ecr:GetAuthorizationToken` on `*`.
- `EcrPush`: `ecr:BatchCheckLayerAvailability`, `ecr:BatchGetImage`, `ecr:CompleteLayerUpload`, `ecr:InitiateLayerUpload`, `ecr:PutImage`, `ecr:UploadLayerPart` on the POS repository only.
- `DeployRun`: `ssm:SendCommand` on the instance ARN and on `arn:aws:ssm:<region>::document/AWS-RunShellScript`.
- `DeployWatch`: `ssm:GetCommandInvocation` and `ssm:ListCommandInvocations` on `*` (neither has a resource form).

GitHub sends this immutable subject, with the numeric IDs, for repositories created after 2026-07-15, so the plain `repo:<owner>/<name>` form would never match.
The IDs also mean a repository deleted and created again under the same name cannot assume the role.
The `sub` claim is built in a `locals` block from `github_repo` and the two ID variables.
A job with an `environment:` would get a different subject, so `deploy.yml` sets none.

GitHub Actions has no S3 permissions and no `ecr:DescribeImages`; the deploy workflow checks whether an image exists with `ecr:BatchGetImage`, which it already has.

### `ecr.tf`

| Resource | Notes |
|---|---|
| `aws_ecr_repository.app` | name `<project_name>`, `image_tag_mutability = "IMMUTABLE"` (tags are commit SHAs), scan on push, AES256 encryption |
| `aws_ecr_lifecycle_policy.app` | keep the last 10 images, tagged or not |

A rollback can only go back to one of those 10 images; the image carries `deploy/` too, so nothing else limits it.

### `secrets.tf` - secrets and settings

Terraform writes 15 SSM parameters under `/<project_name>/prod/`.
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

Ten settings, stored as plain `String`:

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
| `LOG_GROUP` | the log group name, `/<project_name>/prod`, read by the `awslogs` driver in the production compose file |
| `AWS_REGION` | the region of the POS resources, read by the `awslogs` driver |

The secret values also sit in Terraform state, which is why the state bucket must stay private and encrypted.

### `observability.tf`

| Resource | Notes |
|---|---|
| `aws_cloudwatch_log_group.app` | `/<project_name>/prod`, retention `var.log_retention_days`; containers ship logs here with Docker's `awslogs` driver, so pino's JSON lines are searchable in Logs Insights |
| `aws_cloudwatch_metric_alarm.instance_recover` | `<project_name>-instance-recover`, on `StatusCheckFailed_System` (Maximum, 2 periods of 60 seconds, threshold 1), action `arn:aws:automate:<region>:ec2:recover` |

### `outputs.tf`

Seven outputs:

| Output | Copy it to |
|---|---|
| `app_url` | the README (`https://<fqdn>`) |
| `instance_id` | GitHub variable `EC2_INSTANCE_ID` |
| `ecr_repository_url` | GitHub variable `ECR_REPOSITORY_URL` |
| `github_deploy_role_arn` | GitHub variable `AWS_DEPLOY_ROLE_ARN` |
| `aws_region` | GitHub variable `AWS_REGION` |
| `ssm_session_command` | your notes: `aws ssm start-session --target <instance id> --region <region>` |
| `seed_admin_password` | nowhere: marked sensitive, so plan and apply hide it; read it with `terraform output -raw seed_admin_password` to sign in as the first HQ admin the seed creates |

## 5. Containers

### `Dockerfile` (repository root)

Multi-stage, one image for the API and the web app; every stage starts `FROM node:26.13.1-alpine`.

1. `dev`: installs both packages' dependencies with `npm ci` in `/app/api` and `/app/web`, as the `node` user, for the dev stack only.
   The default build target is `runtime`, so a plain `docker build` never builds this stage.
2. `web-build`: `npm ci` and `npm run build` in `web/`, producing `web/dist`.
3. `api-build`: `npm ci`, `npm run build` (`tsc` to `api/dist`; pgtyped-generated code is already committed), then `npm prune --omit=dev`.
4. `runtime`:
   - `NODE_ENV=production` and `WORKDIR /app/api`
   - under `/app/api`: `package.json`, the production `node_modules/`, `dist/`, `migrations/`, and the web build as `public/`
   - the `deploy/` folder (`docker-compose.prod.yml`, `Caddyfile`, `deploy.sh`, `initdb/`) copied to the fixed path `/app/deploy`, so the server gets the deploy files of a release from its image
   - runs as the non-root `node` user
   - `EXPOSE 3000`
   - `HEALTHCHECK` every 10 seconds: `node -e` fetches `http://127.0.0.1:${HTTP_PORT:-3000}/healthz`, because alpine has no `curl`
   - default command `node dist/main.js`; the same image runs `migrate` with `node dist/cli/migrate.js`, and will run `seed` once it exists

Node 26 is the current LTS line; the exact patch is pinned in every `FROM` line.

### `.dockerignore`

Excludes `node_modules`, `dist`, `coverage`, `*.tsbuildinfo`, `.env*` and `.DS_Store` at any depth, plus `.git`, `.adlc/`, `.claude/`, `infra/`, `docs/`, `api/public/`, `api/test/` and `web/test/`.
The build context stays small, and no secret or test file reaches the image.
It must not exclude `deploy/`, because the image carries it.

### `.gitattributes`

Shell scripts and the `Dockerfile` are always checked out with LF line endings, so a Windows checkout cannot break them.
`deploy/initdb/01-roles.sh` must stay executable (mode `100755` in git): the Postgres entrypoint runs an executable `.sh` file but sources one that is not.
`deploy/deploy.sh` is committed executable too, and the deploy command runs it with `bash` either way.

### `docker-compose.yml` (repository root, for local use and reviewers)

- Project name `pos-system`.
- `db`: `postgres:18.7-alpine` with the named volume `db-data` at `/var/lib/postgresql` (the Postgres 18 image keeps its data in a versioned folder under that path), `deploy/initdb` mounted read-only into `/docker-entrypoint-initdb.d`, and a `pg_isready -h 127.0.0.1` healthcheck.
  The healthcheck goes over TCP because, while the init scripts run, Postgres listens only on its socket and would look ready too early.
- `migrate`: builds the image (tagged `pos-system:local`) and runs `node dist/cli/migrate.js` once `db` is healthy.
- `app`: the same image, published on `127.0.0.1:3000` only; starts once `migrate` exits successfully.
- Every service lists its variables in its own `environment:` block, filled from `.env`; no service loads `.env` whole, so `app` never sees the migrator password and `migrate` never sees the token key.
- The two database URLs are built in the compose file from the passwords.
  A missing required variable stops Compose with "copy .env.example to .env".

A reviewer runs `cp .env.example .env`, then `docker compose up --build`, and opens `http://localhost:3000`.
The Compose plugin (`docker compose`) and standalone `docker-compose` both work.

### `.env.example`

Every value in it is public and for local use only: `APP_ENV=local`, `LOG_LEVEL`, `HTTP_PORT`, `PUBLIC_ORIGIN=http://localhost:3000`, `DB_MAX_CONNS`, `ACCESS_TOKEN_TTL`, three local database passwords, and a labelled development `TOKEN_SIGNING_KEY`.
The app refuses that key when `APP_ENV=prod`, so it can never sign production tokens.

### `docker-compose.dev.yml` (repository root, hot reload)

`docker compose -f docker-compose.dev.yml up --build` runs the code from the working tree and reloads it on every save.

- Project name `pos-dev`, with its own volumes, so it never shares a database or containers with the reviewer stack.
- `db` is the same as in `docker-compose.yml`.
  Its port is not published, so pgtyped runs inside the stack: `docker compose -f docker-compose.dev.yml exec api npm run db:generate`.
- `migrate`, `api` and `web` run the `dev` stage (`pos-system:dev`, with `init: true`), with the source bind-mounted (`./api` at `/app/api`, `./web` at `/app/web`) and `node_modules` in the named volumes `api-node-modules` and `web-node-modules`.
- `migrate` runs `npm run migrate`; `api` runs `npm run dev` (tsx watch) on port 3000 once `migrate` succeeds; `web` runs Vite on port 5173 with `--host 0.0.0.0`.
  Both ports are published on `127.0.0.1` only.
- `web` proxies `/api`, `/healthz` and `/readyz` to `http://api:${HTTP_PORT:-3000}` through `VITE_API_PROXY_TARGET`; outside Docker the target defaults to `http://localhost:3000`.
- Each container runs `npm ci` on start only when `package-lock.json` is newer than the install in its volume, so a new dependency needs no image rebuild.
- `api` and `web` set `CHOKIDAR_USEPOLLING=true`.
  On macOS bind mounts (seen on Colima), rename-style saves from editors and git reach neither tsx nor Vite without polling; idle CPU stays under 1% per container.
- `api` sets `PUBLIC_ORIGIN=http://localhost:5173`, because people open the Vite server in this stack.

### `deploy/docker-compose.prod.yml`

Compose project `pos`, with the same start order as locally: `db` healthy, then `migrate` completes successfully, then `app` starts, so a failed migration never starts a new app.

- `db`: `postgres:18.7-alpine`, the same tag as locally, with data in the bind mount `/data/postgres` at `/var/lib/postgresql`, `./initdb` mounted read-only, the same TCP healthcheck, and `restart: unless-stopped`.
  Nothing chowns `/data/postgres`: the Postgres entrypoint starts as root and creates and chowns its data folder itself.
- `migrate`: `${ECR_REPOSITORY_URL}:${IMAGE_TAG}` running `node dist/cli/migrate.js`, with no restart policy.
- `app`: the same image, `restart: unless-stopped`, and `stop_grace_period: 30s`, longer than the app's 10-second `SHUTDOWN_TIMEOUT` drain.
- `caddy`: `caddy:2.11.9-alpine`, `restart: unless-stopped`, publishing 80 and 443, with `./Caddyfile` mounted read-only and `/data/caddy` mounted at `/data`.
  The image sets `XDG_DATA_HOME=/data`, so certificates and the ACME (Automatic Certificate Management Environment) account key land on the data volume; `/config`, Caddy's autosaved copy of its config, is not kept.
  A `pos.caddyfile-sha256` label is set from `CADDYFILE_SHA256`, which `deploy.sh` exports (it is not in `.env`), so a changed Caddyfile changes the label and `up -d` recreates `caddy` with the new file.
- No service except `caddy` publishes a port.
- Each service lists its variables in its own `environment:` block; a missing required value stops Compose with "run deploy.sh to write .env".
- Every service logs with `driver: awslogs`, `awslogs-group: ${LOG_GROUP}`, `awslogs-region: ${AWS_REGION}`, and `tag: <service>/{{.ID}}` as the stream name, because Docker's `awslogs` driver has no stream prefix option.

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
`caddy validate` and `caddy adapt` on `caddy:2.11.9-alpine` confirm that the Let's Encrypt directory is the only issuer and that the `zstd` encoder is present.
The file is indented with tabs, as `caddy fmt` writes it.
The `header` line adds `Strict-Transport-Security`, so browsers use HTTPS only for this domain.
The other security headers (`X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Content-Security-Policy`) are set by the app's `securityHeaders` middleware, so they are the same locally and in production.

### `deploy/initdb/01-roles.sh`

Runs only on the first start of an empty database:

- creates the `migrator` role that owns the `pos` schema
- creates the `pos_app` role with `SELECT, INSERT, UPDATE, DELETE` on tables and `USAGE` on sequences, granted through default privileges set by `migrator`
- sets the session timeouts on the roles with `ALTER ROLE`: `pos_app` gets `statement_timeout` 5s, `lock_timeout` 2s and `idle_in_transaction_session_timeout` 10s; `migrator` gets `lock_timeout` 5s

The full script is in `docs/database-design.md` (Database roles).

### `deploy/deploy.sh`

The deploy's SSM command gets `deploy.sh` onto the server before running it.
It is POSIX `sh`, because the server's `/bin/sh` is dash, and it holds only the commit SHA and checked repository variables, never a secret, because SSM records command parameters.

1. Exports `AWS_REGION`, logs Docker in to ECR with the instance role, and pulls `<ECR_REPOSITORY_URL>:<sha>`.
2. Copies `/app/deploy` out of that image into `/opt/pos` with `docker create` and `docker cp`, then removes the stopped container.
3. Runs `bash /opt/pos/deploy.sh <sha>`.

So the compose file, Caddyfile and scripts always match the image they deploy, and the server never needs a git checkout or a bucket.

`deploy.sh` takes the full 40-character commit SHA as its only argument:

1. Fails fast unless `/data` is a mounted volume, so Postgres never writes to the root disk by mistake, and unless `/data/postgres`, `/data/caddy`, the compose file and the Caddyfile exist.
2. Takes the region from `AWS_REGION`, or else from the instance metadata (IMDSv2).
3. Reads every parameter under `/techzu-pos/prod` (override with `POS_SSM_PATH`), secrets and settings alike.
   It refuses database passwords that are not letters and digits, because they go into URLs.
4. Writes `/opt/pos/.env` with mode `600`, through a temporary file, naming each variable after the last part of the parameter name.
   Every value is in single quotes, so Compose never expands a `$` in it; a name that is not `[A-Z][A-Z0-9_]*`, or a value with a quote or a line break, stops the deploy.
   It adds only `IMAGE_TAG` (its argument) and the two database URLs, built from the passwords.
5. Logs Docker in to ECR with the instance role, and exports `CADDYFILE_SHA256` for the Caddy label.
6. Runs `compose pull` first and only then `up -d --remove-orphans`, without stopping any service beforehand, so the old containers keep serving until the new images are on disk.
7. Polls `https://<APP_DOMAIN>/readyz` every 5 seconds for up to 2 minutes; if it never answers, it prints `compose ps` and exits non-zero, which fails the GitHub Actions job.
8. Once `/readyz` answers, removes the local images of the ECR repository except the current tag and the one the app ran before, then runs `docker image prune -f`, so old releases do not fill the 12 GB root disk.

It never prints a secret.

Rollback is the Deploy workflow with an older commit of `main` as its `sha`; it works for any of the last 10 images kept in ECR.
A rollback redeploys the older image, code and deploy files, but never the older schema: migrations only go forward.
The older image's `migrate` finds nothing new to apply and exits successfully, and the older app runs against the newer schema.
So roll back only across migrations the older code still works with (expand steps, see `docs/database-design.md`, "Expand and contract"); otherwise fix forward with a new commit.

### Application environment (written to `.env` by `deploy.sh`)

| Variable | Value in prod | Comes from |
|---|---|---|
| `APP_ENV` | `prod` | SSM setting |
| `LOG_LEVEL` | `info`; `debug` is refused when `APP_ENV=prod` | SSM setting |
| `HTTP_PORT` | `3000` | SSM setting |
| `PUBLIC_ORIGIN` | `https://pos.afnanio.top` | SSM setting |
| `APP_DOMAIN` | `pos.afnanio.top`, read by the Caddyfile | SSM setting |
| `DB_MAX_CONNS` | `10` | SSM setting |
| `ACCESS_TOKEN_TTL` | `1h` | SSM setting |
| `ECR_REPOSITORY_URL` | the ECR repository URL, read by the compose file | SSM setting |
| `LOG_GROUP` | `/techzu-pos/prod`, read by the compose file's log driver | SSM setting |
| `AWS_REGION` | `ap-south-1`, read by the compose file's log driver | SSM setting |
| `POSTGRES_PASSWORD` | 32 letters and digits | SSM secret |
| `MIGRATOR_PASSWORD` | 32 letters and digits | SSM secret |
| `APP_DB_PASSWORD` | 32 letters and digits | SSM secret |
| `SEED_ADMIN_PASSWORD` | 32 letters and digits, for the seed command; no service receives it yet | SSM secret |
| `TOKEN_SIGNING_KEY` | a PKCS#8 PEM, base64-encoded on one line | SSM secret |
| `IMAGE_TAG` | the commit SHA | `deploy.sh` argument |
| `DATABASE_URL` | `postgres://pos_app:<APP_DB_PASSWORD>@db:5432/pos` | built by `deploy.sh` |
| `MIGRATOR_DATABASE_URL` | `postgres://migrator:<MIGRATOR_PASSWORD>@db:5432/pos` | built by `deploy.sh` |

`.env` feeds Compose's variable substitution only; each container receives just the variables its `environment:` block names.
Database connections never leave the host's Docker network, so they run without TLS (`sslmode=disable`) to the `db` host.
If the database ever moves off the host, TLS becomes required.

## 6. GitHub Actions

### Repository variables (Settings, then Secrets and variables, then Actions, then Variables)

`AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `ECR_REPOSITORY_URL`, `EC2_INSTANCE_ID`, each copied from the Terraform output of the same meaning (section 4, `outputs.tf`).
No AWS secrets are needed, because the workflow uses OIDC.

### Action pins

Every action is pinned to a full commit SHA, with its version in a comment beside it:

| Action | Version | Used in |
|---|---|---|
| `actions/checkout` | v7.0.1 | both workflows, always with `persist-credentials: false` |
| `actions/setup-node` | v7.1.0 | `ci.yml` (Node 26, npm cache per package) |
| `hashicorp/setup-terraform` | v4.0.1 | `ci.yml` |
| `aws-actions/configure-aws-credentials` | v6.3.0 | `deploy.yml` |
| `aws-actions/amazon-ecr-login` | v2.2.0 | `deploy.yml` |

### `.github/workflows/ci.yml` (every pull request and push)

Seven jobs run in parallel with `permissions: contents: read`; on a pull request, a newer push cancels the older run.

| Job | Runner | What it checks |
|---|---|---|
| `api` | `ubuntu-24.04` | `npm ci`, lint, typecheck, tests, build; the tests start their own Postgres with testcontainers, the same way as locally |
| `web` | `ubuntu-24.04` | `npm ci`, lint, typecheck, tests, build |
| `drift` | `ubuntu-24.04` | the pgtyped drift check, below |
| `image` | `ubuntu-24.04-arm` | builds the `runtime` and `dev` targets without pushing, then runs `docker compose config` on `docker-compose.yml` and `docker-compose.dev.yml` with `.env.example` copied to `.env` |
| `pins` | `ubuntu-24.04` | fails unless `docker-compose.yml`, `docker-compose.dev.yml`, `deploy/docker-compose.prod.yml`, `api/test/support/postgres.ts` and `ci.yml` all pin one and the same `postgres:` tag (Markdown and HTML files are skipped) |
| `scripts` | `ubuntu-24.04` | `shellcheck` on every tracked `*.sh` file |
| `terraform` | `ubuntu-24.04` | Terraform 1.16.4: `fmt -check -recursive`, `init -backend=false -lockfile=readonly`, `validate` in `infra/terraform` |

The drift check:

1. Starts a `postgres:18.7-alpine` service container, which exists only for this check.
2. Creates the roles by running `deploy/initdb/01-roles.sh` inside it with `docker exec`, because a service container cannot mount files.
3. Runs `npm run migrate` as `migrator`, then `npm run db:generate` as `pos_app`.
4. Fails if any `src/**/*.queries.ts` file changed or is new, or has no `.sql` file beside it.

### `.github/workflows/deploy.yml` (started by hand, on `main` only)

Nothing deploys on a push or a merge.
A person opens Actions, then Deploy, then "Run workflow" on `main`.

1. `workflow_dispatch` with one optional input, `sha`: left empty, it deploys the tip of `main`; a full 40-character lowercase SHA of an older commit of `main` is a rollback.
2. The job runs only when started on `refs/heads/main`; the deploy role's trust policy is the real boundary.
   It has no `environment:`, because that would change the OIDC subject the role trusts.
3. `permissions: id-token: write, contents: read`; a native ARM runner (`ubuntu-24.04-arm`), so the image is built for the ARM instance without emulation; `concurrency: deploy-prod` without cancelling, so two deploys never overlap.
4. Checks the repository variables against strict patterns (a region name, an instance ID, an ECR URL in that same region) before any of them goes into a command.
5. Resolves the commit: it must exist and be an ancestor of `origin/main`; a SHA other than the tip is a rollback.
6. Assumes the deploy role with `aws-actions/configure-aws-credentials` and `role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}`.
7. Asks ECR for the tag with `aws ecr batch-get-image`.
   If the image exists, the build is skipped and that image is deployed again, because tags are immutable and a second push would fail.
   If it is missing, a rollback fails (a rollback never builds old code), and any other failure code from ECR fails the job.
8. Otherwise logs in with `aws-actions/amazon-ecr-login`, checks the checkout is that SHA, builds the `runtime` target with an `org.opencontainers.image.revision` label, and pushes `${ECR_REPOSITORY_URL}:<sha>`; the image includes `deploy/`.
9. Runs `aws ssm send-command` with `AWS-RunShellScript` on `EC2_INSTANCE_ID` and an `executionTimeout` of 540 seconds; the command pulls the image by SHA, copies `deploy/` out of it, and runs `deploy.sh <sha>` (section 5, `deploy/deploy.sh`).
10. Polls `aws ssm get-command-invocation` every 10 seconds for up to 10 minutes, instead of `aws ssm wait`, which gives up after about 100 seconds.
    It then prints the server's output and errors, and fails the job unless the status is `Success`.

## 7. First-time setup, in order

1. Nothing to fill in: every variable has a committed default (section 1); create `terraform.tfvars` only to override one.
2. Sign in to the right account: `aws sso login --profile <AWS_PROFILE>`, then `export AWS_PROFILE=<AWS_PROFILE>`.
3. In `infra/terraform`: `terraform init`, `terraform plan`, review it, then `terraform apply`.
   This one apply creates the Elastic IP, the instance and the DNS record in the right order.
4. Copy the four outputs into the GitHub repository variables listed in section 6.
5. Protect `main` in GitHub (a branch protection rule or ruleset) before the first deploy, because the deploy role trusts any workflow run on `main` and can run commands as root on the server through SSM.
6. In GitHub, open Actions, then Deploy, then "Run workflow" on `main`, with `sha` left empty.
   The first deploy starts Caddy, which gets the Let's Encrypt certificate on its own; `deploy.sh` waits up to 2 minutes for `/readyz`.
7. Check `https://pos.afnanio.top/healthz` and `/readyz`.
   How the HQ admin and demo users get into prod is not decided yet (section 10).
8. Optional: run the `ssm_session_command` output, then `cd /opt/pos && docker compose -f docker-compose.prod.yml ps` to look around.

If the first database initialisation fails (for example on a bad password), Postgres has already created its data folder and never runs `01-roles.sh` again.
Recover only while the database holds no real data, because there are no backups:

1. Stop the stack over SSM: `cd /opt/pos && docker compose -f docker-compose.prod.yml down`.
2. Empty the data folder: `find /data/postgres -mindepth 1 -delete`.
3. Fix the cause, then start the Deploy workflow again.

Replacing the instance, for example to pick up a newer AMI or an edited `cloud-init.yaml.tftpl` (both are ignored on a normal plan):

1. Stop the stack over SSM so Postgres shuts down cleanly: `cd /opt/pos && docker compose -f docker-compose.prod.yml down`.
2. Run `terraform apply -replace=aws_instance.app`.
   Terraform stops the old instance before it detaches the data volume (`stop_instance_before_detaching`), then attaches the volume to the new one.
3. The new instance's first boot finds the existing filesystem, mounts it without formatting, and keeps the data and certificates.
4. Copy the new `instance_id` output into `EC2_INSTANCE_ID`, then start the Deploy workflow again.

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

## 10. Known follow-ups

Open after the foundation build, 2026-11-25:

- **Checks only a real deploy can make:** the SSM parameter read, the ECR login on the server, the `awslogs` stream names, the Let's Encrypt certificate, `/readyz` reached from the server through its own Elastic IP, and what the SSM shell provides (such as `HOME`) for `docker login`.
  The first deploy started by hand confirms them.
- **Demo data in prod:** nothing runs `npm run seed` on the server, and no SSM parameter holds the outlet users' passwords.
  Decide whether seed runs once by hand over SSM, or prod has no demo data.
- **Password rotation:** `01-roles.sh` runs only on an empty volume, so a password changed in SSM never reaches the database roles; rotation is manual.
- **Rollback window:** a rollback can only reach one of the last 10 images ECR keeps.
- **Backups:** none, by decision, because this is a test deployment.
  A real one would add EBS snapshots, a nightly `pg_dump`, or both.
- **AWS CLI version:** cloud-init installs the latest AWS CLI v2; pin a version if a release ever breaks `deploy.sh`.
- **HTTP/3:** Caddy advertises HTTP/3, which runs over UDP 443, but the security group opens only TCP 443, so browsers try it, fail, and fall back to HTTP/2.
  Later, either open UDP 443 in `network.tf` or set `protocols h1 h2` in the Caddyfile's global options.
- **Health check log lines:** every `/healthz` probe writes a request log line, one every 10 seconds per app container, and those lines go to CloudWatch.
  Skip or sample health checks in `requestLog` if the noise or the cost matters.
- **Postgres memory settings:** `docs/database-design.md` proposes `-c` flags for the 2 GiB host (`max_connections = 40`, `shared_buffers = 256MB` and more); the production compose file does not pass them yet, so Postgres runs with the image defaults.
- **npm audit (accepted by the user, 2026-11-25):** node-pg-migrate 9.0.0 pulls glob and minimatch with 3 moderate advisories; it runs only in the one-off `migrate` container, over fixed paths.
  The dev-only `@pgtyped/cli` pulls tinypool (2 critical), and testcontainers brings moderate ones; neither is in the image.
  Check again when upstream releases fixes.
