# POS system - multi-outlet F&B point of sale

A take-home for a senior technical assessment, built to production standards.
One company runs many food-and-beverage outlets.
HQ owns the master menu, assigns items to outlets with optional price overrides, and watches sales.
Each outlet sells from its own menu and its own stock.

> **STATUS (2026-11-25):** folders, docs and AI guidance only; no code yet.
> `docs/` describes the target design; each feature's spec confirms or changes its part, and updates the doc in the same change.

## What the brief requires

- **Menu:** HQ creates master items, assigns them to outlets and overrides the price per outlet; an outlet reads only its assigned items.
- **Inventory:** stock per outlet per item; sales deduct it; stock never goes negative.
- **Sales:** many items per sale, one database transaction, stock deducted per outlet, a sequential receipt number per outlet that stays correct under concurrent requests.
- **Reports:** total revenue by outlet; top 5 selling items per outlet.
- **Engineering:** PostgreSQL, Express, Node.js, React; routes, controllers, services, repositories; input validation; error middleware; environment config; foreign keys, unique constraints and indexes; Dockerfile; docker-compose; a deployed instance.
- **Deliverables:** the deployed URL; one GitHub repo with a clean folder structure, clean commits and a README (setup, API endpoints, schema, architecture, scaling); an architecture document with an ERD, a scaling plan for 10 outlets and 100,000 transactions a month, a microservices path, and an offline POS and KDS sync strategy.

## Decisions already taken

- TypeScript everywhere; Express 5 API; React 19 + Vite web app.
- Express serves the API under `/api` and the built React app from the same container on port 3000.
- PostgreSQL 18 in a container on the same EC2 host; Caddy in front for automatic HTTPS; no nginx, no API Gateway.
- Data access with `pg` and pgtyped: SQL lives in `.sql` files, pgtyped generates typed query functions, and a schema change surfaces as compile errors.
- Access control: roles, permission keys in the access token, a permission check per route, and an outlet scope check in the service.
  Users belong to one outlet, or to none, which makes them HQ users; HQ manages roles and their permissions.
- Terraform on AWS, applied by the user from their laptop; GitHub Actions builds, pushes to ECR and deploys over SSM.

## Layout

```
api/            Express API (TypeScript): src/platform, src/modules/<area>, migrations, CLI commands
web/            React app: HQ console and outlet POS screens, one build
infra/          Terraform for AWS
deploy/         files that run on the server: production compose, Caddyfile, deploy.sh, initdb
docs/           design docs, infrastructure plan, architecture document (not written yet)
Dockerfile      one image: web build + compiled API
docker-compose.yml   local stack for reviewers: db, migrate, app
.claude/rules/  path-scoped guidance (see below)
```

## Where the guidance lives

This file loads in every session, so it holds only what is true everywhere.
Area rules load on demand, when a file matching their `paths` is read or edited:

| Rule file | Loads for | Covers |
|---|---|---|
| `.claude/rules/backend.md` | `api/**` | layers, file naming, errors, logging, config, validation, access control, testing |
| `.claude/rules/database.md` | migrations, `.sql` files, repositories | schema conventions, constraints, indexes, migrations, pgtyped |
| `.claude/rules/sales.md` | `api/src/modules/{sales,inventory}/**` | the concurrency-safe sale transaction and receipt numbers |
| `.claude/rules/frontend.md` | `web/**` | stack, folders, API client, server state, access in the UI |
| `.claude/rules/infra.md` | `infra/**`, `deploy/**`, Docker files, workflows | Terraform, containers, deploy, what Claude may run |
| `.claude/rules/docs.md` | `docs/**`, `README.md` | writing style and what each document must contain |

A rule file loads only when a matching file is touched, so before speccing or designing work in an area, read that area's rule file yourself.

Deeper detail, read only when needed: `docs/backend-design-patterns.md`, `docs/database-design.md`, `docs/frontend-engineering.md`, `docs/ui-blueprint.html`, `docs/infrastructure.md`.
`docs/system-design.html` and `docs/backend-guide.html` are visual explainers of the same design for people.

## Rules for every change

- **Spec first.** Work follows the ADLC pipeline (spec, architect, implement, review, wrapup) with a gate at each step; small changes use `/task`. The vault lives in `.adlc/` (run `/init` once to create it).
- **Git is the user's.** Claude drafts commit messages and PR bodies; the user runs every git write command.
- **No comments by default.** A comment is one line, and only for a non-obvious why. No ticket or REQ numbers and no `TODO`s in code.
- **Flag before adding.** A new dependency, schema change, or auth or security change is raised at the gate before it is made.
- **Money** is an integer in minor units (`_minor` columns, `number` in TypeScript), never a float.
- **IDs** are UUIDv7 strings generated by the API; **times** are UTC (`timestamptz`, ISO 8601 in JSON).
- **JSON keys** are camelCase in every request and response; validation error keys use those same names.
- **Secrets:** never read `.env`, `*.tfstate` or `terraform.tfvars`; never print or log secrets.
- **Claude never runs** `terraform apply`, `destroy` or `import`, and never uses credentials for the deployed AWS account.
- **Done means verified:** lint, typecheck and tests pass, and UI changes are checked in a browser.

## Commands

Added by the first REQ (foundation).
Target shape: `npm run dev`, `npm run build`, `npm run lint`, `npm run typecheck`, `npm test` in `api/` and `web/`; `npm run migrate`, `npm run seed` and `npm run db:generate` (pgtyped) in `api/`; `docker compose up --build` at the root.
