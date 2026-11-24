---
paths:
  - "api/**"
---

# Backend rules (`api/`)

The Express API.
Full rulebook: `docs/backend-design-patterns.md`.

## Layout

```
api/
  src/
    main.ts               run: loadSettings -> logger -> pool -> buildApp -> serveUntilStopped (SIGTERM: stop accepting, drain, close pool)
    app.ts                buildApp: express() -> platform stack -> mountRoutes -> static web + SPA fallback -> notFound -> errorHandler
    services.ts           buildServices: construct every repository and service once, wire dependencies
    routes.ts             mountRoutes: one line per module
    platform/
      config/             loadBase, loadDatabase, loadHttp, loadTokenSettings; Secret
      logger/             createLogger (pino JSON to stdout), request context (AsyncLocalStorage), logger()
      errors/             AppError, kinds, constructors, kindOf
      http/               requestId, requestLog, errorHandler (writeProblem), validate, respond, notFound
      db/                 createPool, withTx, mapPgError, Db / Tx types
      auth/               token signer (ES256), authenticate, requirePermission, Principal, outlet scope helper
      health/             GET /healthz, GET /readyz (outside /api)
    modules/<area>/       auth, roles, users, outlets, menu, inventory, sales, reports
    cli/                  migrate.ts (migrations + permission sync), seed.ts
  migrations/             plain SQL, numbered, never edited once applied
```

Each module:

| File | Job |
|---|---|
| `<thing>.ts` | model types, `as const` enums, area errors built from `AppError` constructors, input rules |
| `<thing>.dto.ts` | zod request schemas (`.strict()`), response types, `toXResponse` mappers |
| `<thing>.routes.ts` | `register<Thing>Routes(router, controller, auth)`: path, middleware, controller method |
| `<thing>.controller.ts` | parse and validate input, call one service use case, map to a response DTO, `respond()` |
| `<thing>.service.ts` | business rules and the transaction boundary |
| `<thing>.repository.ts` | calls pgtyped queries, maps rows to models, maps database errors |
| `<thing>.sql` -> `<thing>.queries.ts` | pgtyped source and its generated output (generated file never edited) |
| `dependencies.ts` | the small interfaces the service needs, named after the real thing |
| `<thing>.test.ts` | co-located tests |

## Layers

Request flow: **route -> controller -> service -> repository -> pgtyped -> Postgres**.
Dependencies point down only.

- **Controllers** never run SQL, never make business decisions, never write an error body, never log.
- **Services** never import Express types, never know status codes or JSON, and never see pgtyped row types.
- **Repositories** never make business decisions, never open transactions, never know HTTP.
- A module reaches another module only through its service, never its repository or controller.
- `src/platform/*` never imports a module.
- Four data shapes, converted in exactly two places: request DTO -> input (controller), row -> model (repository), model -> response DTO (controller).
  Never return a row or a model as JSON.

## Use cases and steps (transactions)

- A service method with no `tx` parameter is a **use case**: it opens the transaction with `withTx(db, async (tx) => ...)`, and controllers call only these.
- A method that takes `tx` is a **step**: it joins the caller's transaction and never opens one.
- Repositories receive `tx` (or the pool for a single read) as their first argument and never hold a connection.
- `withTx` commits on success, rolls back on any throw, and bounds the rollback with a timeout so a dead connection cannot hang the request.
- Keep transactions short: no network calls, no waiting on anything outside Postgres.
- Default isolation is READ COMMITTED; correctness under concurrency comes from conditional updates and row locks, not higher isolation.

## Errors

- `AppError` carries a `kind`: `validation` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404, `conflict` 409, `invalid_reference` 400, `too_large` 413, `rate_limited` 429, `unavailable` 503, `canceled` 499, `unexpected` 500.
- Area errors are declared once in `<thing>.ts` (`export const ErrInsufficientStock = conflict('Not enough stock')`) and checked by identity or `kindOf`.
- `mapPgError`: 23505 -> conflict, 23503 -> invalid_reference, 23001 (restrict violation: still referenced) -> conflict, 23514 -> validation with a generic title (constraint name only in the log), 40001 / 40P01 (serialization failure, deadlock) and 57014 / 55P03 / 25P03 / 53300 and connection errors -> unavailable; anything else stays unexpected.
- An area error that must name the item uses `withTitle(ErrInsufficientStock, ...)`; callers match it with `isError(err, ErrInsufficientStock)`, which walks the `cause` chain.
- **`errorHandler` is the only code that writes an error body**: RFC 7807 `application/problem+json` with `type`, `title`, `status`, `instance`, `requestId`, and `errors` only for validation; `Cache-Control: no-store`; 500s never leak internals.
- If headers were already sent, `errorHandler` logs and destroys the socket instead of writing a body.
- Express 5 forwards thrown errors and rejected promises to `errorHandler`; `unhandledRejection` and `uncaughtException` log at fatal and exit, and Docker restarts the container.
- An unknown path gives 404 through `notFound`; a known path with the wrong method gives 405 through `methodNotAllowed` (slug `method-not-allowed`); both go through `errorHandler`.
- `canceled` (499) comes from the request's `AbortSignal` in the request context, aborted when the client disconnects.

## Middleware chain (outermost first)

`requestId -> securityHeaders -> requestLog -> jsonBody (1 MB limit) -> routes -> authenticate (per route) -> requirePermission (per route) -> controller -> errorHandler`

- `requestId`: keep an incoming `X-Request-Id` only if it is 1-64 chars of `[A-Za-z0-9._-]`, else generate a UUIDv7; set the response header; open the AsyncLocalStorage request context with a child logger carrying `requestId`.
- `requestLog`: exactly one info line per request on `finish` or `close`: `method`, `route` (the pattern, never the raw path; `unmatched` if none), `status`, `durationMs`, `bytes`, `requestId`, plus `userId` and `outletId` when authenticated.
- `securityHeaders` sets `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options` and the web app's `Content-Security-Policy` with no extra dependency; Caddy adds HSTS.
- `jsonBody` wraps `express.json` and re-binds `next` with `AsyncResource.bind`, because the body parser otherwise loses the AsyncLocalStorage request context; a test pins it.
- No CORS middleware: the browser always calls the same origin.

## Logging

- pino, JSON to stdout, level from `LOG_LEVEL` (`debug` only locally).
- Code logs through `logger()` from the request context, never `console.log`.
- `error` level only for unexpected failures, logged **once**, in `errorHandler` (with the cause chain and stack). `unavailable` logs at warn, `canceled` at info. Never log an error and also rethrow it.
- Never logged: request or response bodies, passwords, tokens, cookies, `Authorization` headers. IDs only.

## Config

- Read once at startup by explicit loaders (`loadBase`, `loadDatabase`, `loadHttp`, `loadTokenSettings`), each taking the env object and validating with zod.
- A loader reports **every** bad setting in one error, and the process exits before listening.
- `APP_ENV` (`local`, `prod`) is required with no default.
- Secrets are wrapped in `Secret`, which prints `xxxxx` in logs, `JSON.stringify` and `util.inspect`; call `.reveal()` only where the value is used.
- No `process.env` outside `platform/config` and `main.ts`.

## Validation

- Every body, query and path parameter is parsed by a zod schema in `<thing>.dto.ts` before the controller uses it.
- Schemas are `.strict()`: unknown fields are a 400.
- Field error keys are the JSON names (`menuItemId`, `items[0].quantity`).
- JSON parse failures and oversized bodies become a fixed problem message; the parser's text can quote the body, so it never reaches the client.

## API conventions

- Business routes under `/api/v1`; health at `/healthz` and `/readyz`.
- Plural resources; outlet-owned data under `/api/v1/outlets/:outletId/...`.
- Lists that grow (sales) use keyset pagination by `receipt_number DESC` (`?after=<cursor>&limit=50`, at most 100, response `{ items, nextCursor }`), never offset; other lists return everything.
- `POST /api/v1/outlets/:outletId/sales` accepts an `Idempotency-Key` header; a repeat returns the original sale. Offline sync depends on this.

## Access control

- Login sets an ES256 JWT in an HttpOnly cookie (`__Host-pos_at` over HTTPS, `pos_at` locally); other clients may send `Authorization: Bearer`.
- The token carries `sub` (user ID), `outletId` (or null for HQ users) and `perms` (permission keys).
- `authenticate` is named on each protected route, never global; public routes simply omit it. It puts a `Principal` in the request context.
- `requirePermission(...keys)` per route: 403 unless the token holds at least one key.
  HQ read screens accept any related key: `GET /outlets*` takes `outlets.manage`, `menu.assign` or `inventory.manage`; `GET /menu-items*` takes `menu.manage` or `menu.assign`.
- **Outlet scope is checked in the service**, not middleware: an outlet user may act only on their own `outletId`; an HQ user may act on any outlet. A mismatch is 403.
- Permission keys are `area.action` (`menu.manage`, `sales.create`, `reports.read`) and are defined only in `src/modules/roles/permission.ts`; `cli/migrate.ts` syncs them into the database.
- Built-in roles are locked so HQ cannot remove its own access; HQ can create and edit every other role.
- Login errors are generic ("Invalid email or password"), and an unknown email still verifies a dummy hash so timing reveals nothing.
- Tokens are verified without a database call, so disabling a user or changing a role takes effect at their next sign-in, at most `ACCESS_TOKEN_TTL` later.

## Naming

- Files `kebab-case`, named after the area's thing: `menu-item.service.ts`, `sale.repository.ts`.
- Classes and types `PascalCase`; functions and variables `camelCase` with explicit names (`menuItemRepository`, not `repo`).
- Service methods name the use case (`createSale`, `assignToOutlet`); repository methods are named exactly like the pgtyped query they run.
- Constructor parameters and fields use the same name as the interface they hold.
- No `any`; use `unknown` with narrowing. No `enum`; use `as const` objects with a derived union.
- Independent async work uses `Promise.all`, not `await` in a loop.

## Testing

- vitest for unit tests; supertest for routes; integration tests against real Postgres via testcontainers, locally and in CI (required for anything touching transactions, constraints or migrations).
- No mocking the database in repository tests; fakes only for outside services.
- Every use case has a happy-path test and a test per business rule it enforces.
