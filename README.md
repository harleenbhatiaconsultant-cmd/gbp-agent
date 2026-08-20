# GBP Growth Agent

Google Business Profile management and local SEO optimization for businesses and agencies.

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — system design, data model, security requirements
- **[DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)** — phases, MVP scope, open decisions
- **[docs/DEPLOYMENT_RAILWAY.md](docs/DEPLOYMENT_RAILWAY.md)** — deployment topology (not deployed yet)

**Current state: Phase 0 complete.** The foundation boots, the schema migrates, and the
safety defaults are enforced in code. No product features yet — Phase 1 begins with tenancy
and auth.

---

## What this platform will not do

These are enforced in code, not just documented:

- No guaranteed ranking claims. A claims linter rejects guarantee language in generated copy.
- No review gating (screening customers by sentiment before requesting a review).
- No generated review *content* — only owner responses to real reviews.
- No business-name keyword manipulation. Name changes always require a human approver.
- No profile value the model invented. Every proposed change carries a source reference.

## Prerequisites

- Node.js 20.19+ (developed on v24)
- PostgreSQL 16

This machine already has a portable Postgres 16 at `C:\Users\HP\pgportable`, data directory
`C:\Users\HP\pgdata`. Start it with:

```bash
C:/Users/HP/pgportable/pgsql/bin/pg_ctl -D C:/Users/HP/pgdata -l C:/Users/HP/pg-server.log start
```

Keep the log file **outside** the data directory — Postgres fsyncs the data directory on
startup and will stall for 30 seconds retrying a log file it cannot open there.

## Setup

```bash
npm install
cp .env.example .env        # then fill in the values
npm run db:migrate          # applies migrations to the dev database
npm run db:setup:test       # creates/migrates the separate test database
npm run dev                 # http://localhost:3000
```

The app refuses to boot on invalid configuration rather than failing later in a confusing
place. If it exits at startup, read the message — it names the variable.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run worker` | Worker process (idle until Phase 4) |
| `npm run scheduler` | Scheduler process (idle until Phase 4) |
| `npm run check` | typecheck + lint + tests — run before every commit |
| `npm run test` | Vitest, against the test database |
| `npm run db:migrate` | Create and apply a migration |
| `npm run db:studio` | Prisma Studio |

## Architecture in one paragraph

Three processes share one Postgres: `web` (Next.js UI and route handlers), `worker` (all
Google API traffic, audits, AI calls, change execution), and `scheduler` (enqueues recurring
work). Every change to a customer profile travels through six persisted stages — observe,
diagnose, recommend, approve, execute, verify — each with its own table, so the platform can
always answer who decided a change, who approved it, what was sent, and whether it landed.

## Layer boundaries

```
app/            route handlers and RSC pages — no business logic, no Prisma, no external calls
server/services business logic, tenant-scoped, owns transactions
server/audit    pure rule functions over an immutable snapshot — no I/O
server/actions  one executor per ActionType
server/policy   compliance guardrails and risk scoring
server/integrations  Google / AI / rank / crawler clients with typed errors
server/db       Prisma client and tenant-scoping extension
```

These are enforced by `no-restricted-imports` zones in `eslint.config.mjs`, not by convention.
A component importing `@/server/integrations/*` fails lint.

## Safety defaults

Two defaults matter more than the rest, and both are asserted by tests in
`tests/unit/features.test.ts`:

- **`GBP_WRITE_MODE=validate_only`** — every Google write carries `validateOnly=true` and
  mutates nothing. Google offers no sandbox, so this is the only safe rehearsal. The env
  loader refuses `live` unless `NODE_ENV=production`.
- **`ENABLE_AUTO_APPLY=false`** — unattended changes require three independent conditions:
  the global flag, per-organization opt-in for that specific action type, and a LOW risk
  classification. Business name and category changes can never auto-apply at all.

## Append-only compliance tables

`ChangeLog`, `AuditEvent` and `PolicyViolation` can be inserted and read, never updated or
deleted. Enforced twice: a Prisma client extension (fails fast in development) and Postgres
triggers (hold even for raw SQL). Both are covered by `tests/integration/append-only.test.ts`.

## Tenant isolation

`Organization` is the tenant root. Use `tenantDb(organizationId)` for anything tenant-owned;
it injects `organizationId` into every query so a forgotten `where` is scoped rather than
leaking. Cross-tenant reads return absent, not forbidden — confirming a resource exists in
another tenant is itself a leak. Covered by `tests/integration/tenant-isolation.test.ts`.
