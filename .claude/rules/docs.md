---
paths:
  - "docs/**"
  - "README.md"
---

# Documentation rules

## Style

- Each full sentence on its own line; normal Markdown structure otherwise.
- Plain dash `-`, never an em dash.
- Lead with the answer, then the detail; plain words; expand an acronym the first time it appears.
- Diagrams (ERD, architecture, flows) in Mermaid, so GitHub renders them and they stay editable in the repo.
- A doc that describes code is updated in the same change as that code.
- The docs describe the target design; a feature that builds or changes something updates its section, and the rules files and docs must keep agreeing.

## What each document must contain

- **`README.md`** (the brief grades it): setup instructions (local with Docker, local without Docker), demo URL and demo logins, API endpoints (method, path, permission, short purpose), schema explanation, architecture explanation, scaling strategy summary linking to the architecture document.
- **`docs/architecture.md`** (the brief's architecture document):
  - ERD of every table and relationship.
  - Scaling plan for 10 outlets and 100,000 transactions a month, covering database scaling, reporting performance, infrastructure and architectural evolution, with numbers (rows per month, writes per second at peak, index and storage growth).
  - Conversion to microservices: which parts split out first and why, and what stays together.
  - Offline POS mode: how terminals keep selling, queue sales locally and sync to HQ on reconnect (idempotency keys, receipt numbering while offline, stock conflicts), and how POS and KDS keep talking on the outlet's local network while the internet is down.
- **`docs/backend-design-patterns.md`, `docs/database-design.md`, `docs/frontend-engineering.md`:** the rulebooks behind `.claude/rules/`; the rules files are the short version and must agree with them.
- **`docs/infrastructure.md`:** the AWS and delivery plan; kept in step with `infra/`, `deploy/` and the workflows.
- **`docs/ui-blueprint.html`:** every page's route, permission, contents and states; a page that differs from it updates the blueprint in the same change.
- **`docs/system-design.html`, `docs/backend-guide.html`:** visual explainers for people; kept in step with the Markdown docs they illustrate.
