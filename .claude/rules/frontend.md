---
paths:
  - "web/**"
---

# Frontend rules (`web/`)

One React build, served by the API container from the same origin.
Full patterns: `docs/frontend-engineering.md`; every page: `docs/ui-blueprint.html`.

## Stack

React 19, Vite, TypeScript (`strict`), React Router v7 (`createBrowserRouter`), TanStack Query for server state, Zustand for client UI state only, react-hook-form + zod, Tailwind v4 + shadcn/ui, sonner for toasts, axios.
Tests: vitest, Testing Library and MSW.
English only; no i18n layer.

## Layout

```
src/
  main.tsx                QueryClientProvider -> RouterProvider -> Toaster
  router.tsx              /login; /hq/* (HQ console); /outlet/* (outlet POS); /403, 404
  app/queryClient.ts
  app/routes/             RequireAuth, RequireArea (HQ users stay in /hq, outlet users in /outlet), RequirePermission
  components/ui/          shadcn components (our code)
  components/layout/      HqLayout, OutletLayout, PageHeader, AccountMenu
  features/<area>/        auth, menu, outlets, inventory, sales, reports, roles, users
    api.ts                typed calls through the shared client
    hooks.ts              useQuery / useMutation wrappers
    schemas.ts            zod form schemas
    pages/                one file per route
    components/<page>/    parts of one page
  lib/api/                client.ts (axios on /api), ApiError.ts (problem document -> kind + field errors)
  lib/errors/             describeApiError, handleMutationError
  lib/money.ts            minor units <-> display, the only place money is formatted
  lib/queryKeys.ts
```

## Rules

- The browser calls the relative path `/api/v1/...` on its own origin; locally Vite proxies `/api` to `http://localhost:3000`, deployed it is the same container. No CORS, no `withCredentials`, no auth header.
- No token in JavaScript: the session is the HttpOnly cookie; "who am I" is `useMe()` on `GET /api/v1/me`. Never store tokens in Zustand, localStorage or sessionStorage.
- A 401 from any call except `/me` and login invalidates the `me` query, so `RequireAuth` sends the user to login.
- What a user sees follows their permissions from `useMe()`: HQ users land on `/hq`, outlet users on `/outlet`; menu entries and buttons the user cannot use are hidden, and the API still enforces every rule.
- Server data is read with queries and changed with mutations; never `useEffect` + `fetch`, never copied into Zustand.
- API types mirror the camelCase wire shape with no key mapping; `ApiError.fields` keys match form field names, so server validation errors land on the right input.
- Money arrives in minor units and is formatted only through `lib/money.ts`, in the one company currency.
- The POS sell screen sends an `Idempotency-Key` (a UUID made when the cart is started) with every sale, and keeps it on retry; a new key is made only after a successful sale or when an editable cart is cleared.
- After a network error, timeout or 5xx, the cart locks and "Retry" resends the same key, so a sale is never charged twice.
- The cart (item IDs, quantities, key, status) lives in a Zustand store saved to `sessionStorage` per user and outlet, so it survives a reload or a sign-in after a 401; this is the only data allowed in browser storage.
- Every page handles its loading, empty, error and forbidden states, not only the happy path.
- Components stay presentational; data fetching lives in the feature's hooks.
- No `any`, no `enum`, no `eslint-disable` without a one-line reason.
- Every value in `import.meta.env` is public; no secrets in the frontend.
