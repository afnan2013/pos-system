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
- No AWS keys anywhere: GitHub Actions assumes a role through OIDC, limited to this repository's `main` branch.
- IAM policies name exact resources; `*` only where the action has no resource form (`ecr:GetAuthorizationToken`, `ssm:GetCommandInvocation`).

## Containers

- One `Dockerfile` at the root, multi-stage: build web, build API, then a `node:26-alpine` runtime with exact version pins.
- The runtime runs as the non-root `node` user, has `NODE_ENV=production`, a `HEALTHCHECK` on `/healthz`, and no dev dependencies.
- The same image runs the server, `migrate` and `seed`; only the command differs.
- `.dockerignore` keeps `node_modules`, `.env*`, `.git`, `infra/`, `.adlc/` and `.claude/` out of the build context.
- Root `docker-compose.yml` is for local runs and reviewers (`docker compose up --build` works with only `.env.example` copied to `.env`).
- `deploy/docker-compose.prod.yml` is for the server: ECR image by commit SHA, Caddy, Postgres data on `/data/postgres`, `awslogs` logging, no port published except Caddy's 80 and 443.
- Start order is enforced: `db` healthy, then `migrate` completes successfully, then `app` starts.

## Deploy

- CI ships code only: build the ARM image, push it tagged with the commit SHA, upload `deploy/` to the deploy bucket under that SHA, run `deploy.sh <sha>` over SSM.
- `deploy.sh` refuses to run if `/data` is not mounted, writes `.env` from SSM Parameter Store with mode 600, and fails the job if `/readyz` does not answer.
- Rollback is deploying an older SHA; image tags are immutable.
- Shell scripts start with `set -euo pipefail` and pass `shellcheck`.

## Workflows

- `ci.yml`: install, lint, typecheck, tests against a Postgres service, pgtyped drift check, web build, `terraform fmt -check` and `validate`.
- `deploy.yml`: on push to `main` after CI, `id-token: write`, native ARM runner, one deploy at a time (`concurrency`).
- Actions are pinned to a full commit SHA, not a moving tag.
