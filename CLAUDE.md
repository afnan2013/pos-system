# POS system - multi-outlet F&B point of sale

A take-home for a senior technical assessment, built to production standards.
One company runs many food-and-beverage outlets.
HQ owns the master menu, assigns items to outlets with optional price overrides, and watches sales.
Each outlet sells from its own menu and its own stock.

> **STATUS (2026-11-25):** the foundation is built: the API platform layer (config, logging, errors, middleware, database access, health checks, migrations, pgtyped), the web app shell, one container image, a local stack, a hot-reload dev stack, CI and a deploy workflow started by hand.
> There is no database schema, sign-in or business feature yet; the next features add them.
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
- Express serves the API under `/api/v1`, health checks at `/healthz` and `/readyz`, and the built React app, from the same container on port 3000.
- PostgreSQL 18 in a container on the same EC2 host; Caddy in front for automatic HTTPS; no nginx, no API Gateway.
- Data access with `pg` and pgtyped: SQL lives in `.sql` files, pgtyped generates typed query functions, and a schema change surfaces as compile errors.
- Access control: roles, permission keys in the access token, a permission check per route, and an outlet scope check in the service.
  Users belong to one outlet, or to none, which makes them HQ users; HQ manages roles and their permissions.
- Terraform on AWS, applied by the user from their laptop; GitHub Actions builds, pushes to ECR and deploys over SSM, only when the user starts a deploy by hand.

## Layout

```
api/            Express API (TypeScript): src/platform, src/modules/<area>, migrations, CLI commands
web/            React app: HQ console and outlet POS screens, one build
infra/          Terraform for AWS
deploy/         files that run on the server: production compose, Caddyfile, deploy.sh, initdb
docs/           design docs, infrastructure plan, architecture document (not written yet)
Dockerfile      one image: web build + compiled API
docker-compose.yml   local stack for reviewers: db, migrate, app
docker-compose.dev.yml   hot-reload dev stack: db, migrate, api (tsx watch), web (Vite)
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

Each package is its own npm project with its own lock file; run its commands inside `api/` or `web/` (Node 26, see `.nvmrc`).

| `api/` | What it does |
|---|---|
| `npm run dev` | `tsx watch` on `src/main.ts`, logs made readable by `pino-pretty`; settings come from the environment (no `.env` file is read), so the dev stack below is the easy way |
| `npm run build` / `npm start` | compile to `dist/` / run `node dist/main.js` |
| `npm run lint` / `npm run format` | ESLint and `prettier --check` / `prettier --write` |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `test/` |
| `npm test` | vitest; database tests start their own Postgres with testcontainers, so Docker must be running |
| `npm run migrate` | apply `api/migrations/` with node-pg-migrate as `migrator` (`MIGRATOR_DATABASE_URL`) |
| `npm run db:generate` | regenerate `*.queries.ts` with pgtyped against a migrated database (`DATABASE_URL`) |
| `npm run seed` | placeholder; prints that nothing is seeded until the schema exists |

| `web/` | What it does |
|---|---|
| `npm run dev` | Vite on port 5173, proxying `/api`, `/healthz` and `/readyz` to `VITE_API_PROXY_TARGET` (default `http://localhost:3000`) |
| `npm run build` / `npm run preview` | type-check and build to `dist/` / serve that build |
| `npm run lint` / `npm run format` / `npm run typecheck` / `npm test` | as in `api/` (tests: vitest, Testing Library, MSW) |

Docker, at the repository root, after `cp .env.example .env` (every value in it is public and local-only):

- `docker compose up --build`: the reviewer stack (`db`, then `migrate`, then `app`) at `http://localhost:3000`.
- `docker compose -f docker-compose.dev.yml up --build`: the hot-reload stack; open `http://localhost:5173` (Vite), the API is on port 3000, and edits in `api/src` and `web/src` reload without a rebuild.
  Run pgtyped inside it with `docker compose -f docker-compose.dev.yml exec api npm run db:generate`.
- `down -v` on either stack stops it and deletes its volumes, the database included.
- The Compose plugin (`docker compose`) and standalone `docker-compose` both work.
- On Colima, the API tests need `export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock` and `export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`; CI needs neither.

Deploy is manual only: in GitHub, Actions, then Deploy, then "Run workflow" on `main`.
Leave `sha` empty to deploy the tip of `main`, or give an older commit of `main` to roll back; nothing deploys on push or merge (`docs/infrastructure.md` section 6).
