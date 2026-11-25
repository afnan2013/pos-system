---
paths:
  - "infra/**"
  - "deploy/**"
  - "Dockerfile"
  - ".dockerignore"
  - "docker-compose*.yml"
  - ".github/workflows/**"
---

# Infrastructure and delivery rules

The full plan, file by file: `docs/infrastructure.md`.
Build to that plan; if a file needs to differ, update the plan in the same change.

## What Claude may and may not do

- May write HCL, run `terraform fmt` and `terraform validate`, and draft `plan` and `apply` commands for the user.
- **Never** runs `terraform apply`, `destroy` or `import`, never uses credentials for the deployed AWS account, and never runs `aws` commands that change anything.
- Never reads `*.tfstate`, `.terraform/`, `terraform.tfvars` or any `.env` file.

## Terraform (`infra/terraform/`)

- State sits in an existing shared S3 state bucket under this project's own key `techzu-pos/prod/terraform.tfstate`, with `use_lockfile = true`; there is no bootstrap stack.
- One environment, prod; every resource is named with the `project_name` prefix and tagged `Project`, `Environment`, `ManagedBy`.
- Stateful resources (the Postgres data volume) have `prevent_destroy`; the instance ignores `ami` and `user_data` changes so a plan never replaces it by surprise.
- No SSH: port 22 stays closed, access is through SSM.
- No AWS keys anywhere: GitHub Actions assumes a role through OIDC, limited to this repository's `main` branch by the immutable subject `repo:<owner>@<owner id>/<name>@<repo id>:ref:refs/heads/main` (IDs are the `github_owner_id` and `github_repo_id` defaults).
- IAM policies name exact resources; `*` only where the action has no resource form (`ecr:GetAuthorizationToken`, `ssm:GetCommandInvocation`, `ssm:ListCommandInvocations`).
- `kms:Decrypt` is allowed only on the AWS-managed `alias/aws/ssm` key and only through SSM (`kms:ViaService`); neither role has S3 permissions.
- SSM parameter names under `/<project_name>/prod/` end in the exact environment variable name; they are the contract with `deploy.sh` and the app.
- There are no backups (test deployment); losing the data volume loses the data.

## Containers

- One `Dockerfile` at the root, multi-stage, every stage on `node:26.13.1-alpine`: `dev` (dependencies only, for the dev stack), `web-build`, `api-build`, then the default `runtime`.
- Runtime layout: `WORKDIR /app/api` holding `dist/`, production `node_modules/`, `migrations/` and the web build as `public/`; `deploy/` at `/app/deploy`; server `node dist/main.js`, migrate `node dist/cli/migrate.js`.
- The runtime runs as the non-root `node` user, has `NODE_ENV=production`, a `HEALTHCHECK` on `/healthz`, and no dev dependencies.
- The same image runs the server, `migrate` and `seed`; only the command differs.
- `.dockerignore` keeps `node_modules`, `dist`, `.env*`, `.git`, `infra/`, `docs/`, `.adlc/`, `.claude/` and both `test/` folders out of the build context.
- Exact image pins, one Postgres tag everywhere: `postgres:18.7-alpine` (both local compose files, prod compose, CI, the testcontainers helper; CI's `pins` job fails on a mismatch) and `caddy:2.11.9-alpine`.
- Root `docker-compose.yml` is for local runs and reviewers (`docker compose up --build` works with only `.env.example` copied to `.env`); `docker-compose.dev.yml` (project `pos-dev`) is the hot-reload stack on the `dev` stage.
- Every compose service names its variables in its own `environment:` block; no service loads `.env` whole.
- Postgres healthchecks use `pg_isready -h 127.0.0.1` (TCP), because during init the server listens only on its socket.
- The `Caddyfile` names Let's Encrypt as its only certificate issuer, because the CAA record allows no other, and adds `Strict-Transport-Security`; the app sets the other security headers itself.
- `deploy/docker-compose.prod.yml` (project `pos`) is for the server: ECR image by commit SHA, Caddy with `/data/caddy` at `/data`, Postgres data on `/data/postgres` at `/var/lib/postgresql`, `awslogs` logging to `${LOG_GROUP}` in `${AWS_REGION}`, no port published except Caddy's 80 and 443.
- Start order is enforced: `db` healthy, then `migrate` completes successfully, then `app` starts.

## Deploy

- Deploys start only by hand (`deploy.yml`, `workflow_dispatch` on `main`); nothing deploys on push or merge.
- The workflow builds the ARM image with `deploy/` inside it at `/app/deploy` and pushes it tagged with the commit SHA (skipped when ECR already has that tag), then over SSM pulls that image, copies `deploy/` out with `docker create` and `docker cp`, and runs `deploy.sh <sha>`; there is no deploy bucket.
- `deploy.sh` refuses to run if `/data` is not mounted, writes `.env` with mode 600 from every SSM parameter (values single-quoted) plus `IMAGE_TAG` and the two database URLs, pulls before `up -d` without stopping services first, fails the job if `/readyz` does not answer within 2 minutes, then removes old POS images except the current and previous ones.
- Rollback is the deploy workflow with an older SHA of `main`, one of the last 10 images ECR keeps; image tags are immutable.
  It never rolls back the schema: migrations only go forward.
- SSM commands carry only the SHA and checked repository variables, never secrets, and are POSIX `sh`.
- Shell scripts start with `set -euo pipefail` and pass `shellcheck`.

## Workflows

- `ci.yml` (every push and pull request), seven jobs: `api` and `web` (install, lint, typecheck, tests with testcontainers as locally, build), `drift` (Postgres service container, roles script, migrate, regenerate, fail on any difference), `image` (both image targets on ARM, no push, plus `compose config`), `pins` (one Postgres tag), `scripts` (`shellcheck`), `terraform` (`fmt -check`, `init -backend=false`, `validate`).
- `deploy.yml`: `workflow_dispatch` only, from `main`, optional `sha` input for a rollback; `id-token: write`, native ARM runner, one deploy at a time (`concurrency`), no `environment:` (it would change the OIDC subject); waits up to 10 minutes for the SSM command and fails if it fails.
- Actions are pinned to a full commit SHA, not a moving tag.
