# GBP Growth Agent

Google Business Profile management and local SEO optimization for businesses and agencies.

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — system design, data model, security requirements
- **[DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)** — phases, MVP scope, open decisions
- **[docs/DEPLOYMENT_RAILWAY.md](docs/DEPLOYMENT_RAILWAY.md)** — deployment topology (not deployed yet)

**Current state: Phases 0, 1, 2, 3 and 5 complete.** Tenancy and auth, the Google OAuth
connection, location import with immutable snapshots, and the audit rule engine are all
working end to end. Running an audit produces a real health score with an explainable
breakdown.

Nothing is write-capable: no code path mutates a Google Business Profile. The executor
registry, policy engine and approval queue are Phase 6.

Try it without Google credentials:

```bash
npm run db:seed     # demo org with a healthy and a neglected location
npm run dev         # sign in as demo@example.com, open /demo-agency/locations
```

The seed writes ordinary rows through the ordinary schema — the audit that runs against them
is the real engine, not a mock.

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

## The audit engine

Rules live in [`src/server/audit/rules/`](src/server/audit/rules), one file each, as pure
functions of an immutable snapshot. No I/O — enforced by a lint zone — which is what makes an
audit reproducible months later and testable against fixtures with no database.

A rule returns `pass`, `fail`, or **`skipped`**, and the third one carries the weight:

> **Skipped is not pass.** Checks that could not run (reviews are not synced, the website is
> not connected) are excluded from *both* sides of the score and reported as coverage. A
> profile cannot look healthy because half the ruleset never ran, and the UI shows the score
> and coverage together for exactly that reason.

Findings are tracked by a stable fingerprint across runs, so `RESOLVED` means genuinely fixed.
Re-observing the same issue marks the older row `SUPERSEDED` — collapsing the two would report
a fix on every audit run and make the client-facing history worthless.

## Status by phase

| Phase | Scope | State |
|---|---|---|
| 0 | Foundation, schema, safety defaults | done |
| 1 | Tenancy, auth, RBAC, invitations | done |
| 2 | Google OAuth connection, encrypted tokens | done (needs credentials to test live) |
| 3 | Location import, immutable snapshots | done (needs API access approval) |
| 5 | Audit rule engine, health score, findings | done |
| 4 | BullMQ jobs, scheduling, quota governor | done — inactive until REDIS_URL is set |
| 6 | Executors, policy engine, approval queue | done — write path built and tested, gate closed |

## The change pipeline (Phase 6)

Proposing a change runs it through the compliance guardrails before it becomes queueable. A
BLOCKED change never becomes a ChangeRequest at all — the refusal is recorded permanently as a
`PolicyViolation`, and no approval can override it.

Guardrails, each a pure function with adversarial tests:

| Guardrail | Blocks |
|---|---|
| Business name integrity | Names that add a city, a service keyword, or marketing language |
| Fabrication guard | A model being the *source of a fact* — phone, address, hours, categories |
| Ranking claims | Guarantees, "#1", "first page" in any published text |
| Keyword stuffing | Repetition and density above natural prose |
| Category integrity | Duplicate or malformed category sets |
| Blast radius | More than N applied changes per location per day |

Review gating and fake reviews are not blocked at runtime — they are **unrepresentable**. No
action type exists that could request them, and a test asserts the enum stays that way.

### Execution is gated twice

```
approve (named human)  ->  dry run (validateOnly=true)  ->  live write  ->  verify
                                                   ^
                                     stops here unless GBP_WRITE_MODE=live
```

Under the default configuration the pipeline **cannot reach a live profile even with valid
credentials loaded**. That is asserted against the provider's actual call log in
`tests/integration/change-pipeline.test.ts`, not inferred from a flag. A companion suite forces
the gate open in isolation to prove the write path behind it is correct — dry run first, ChangeLog
and status in one transaction, no double-apply on retry, and verification that catches a value
Google did not persist.

## Background jobs (Phase 4)

Three processes, one database, one Redis. `web` enqueues, `worker` consumes, `scheduler` only
registers recurring work — **pin the scheduler to one replica** or every schedule fires twice.

| Schedule | Cron (UTC) | Does |
|---|---|---|
| `maintenance.tokenRefreshSweep` | `15 * * * *` | Refreshes every connection, so revoked access is noticed within the hour instead of at 3am |
| `maintenance.reapStaleJobs` | `45 * * * *` | Marks runs abandoned by a dead worker as failed |
| `sync.fanout` | `0 2 * * *` | Enqueues one sync per active connection |
| `audit.fanout` | `0 4 * * 1` | Enqueues one audit per location — after the nightly sync, not before |
| `maintenance.snapshotPrune` | `30 3 * * 0` | Prunes superseded snapshots, keeping any an AuditRun references |

Schedules enqueue a **fan-out** job rather than the work itself, so the set of schedules stays
fixed regardless of customer count, and a scheduler restart is harmless. Every enqueued job has a
deterministic id (`name:subject:bucket`), so a restart, an overlapping tick or a double-click
cannot queue the same work twice.

**Queueing is optional infrastructure.** Without `REDIS_URL` the app runs normally, enqueue is a
logged no-op, and syncing and auditing still work on demand — the platform must be usable before
the queue exists. But if `REDIS_URL` *is* set and unreachable, the worker and scheduler **exit**
rather than hang: a process that looks alive while processing nothing is worse than one that
restarts.

### Authority

A background job carries **no authority of its own**. System contexts may observe and diagnose —
sync, audit, view — and may never approve, manage connections, or change membership. A job can
carry out an approved change only by presenting the stored approver, so enqueueing can never
become a route to applying something nobody approved.

### Quota

The governor sits inside the provider, so no caller can forget it. Writes consume both budgets:
the global request rate and Google's far tighter ~10 edits/minute **per profile**. Redis-backed
where available so the limit holds across every instance, with an in-process fallback that is
correct for a single instance.

> **Not yet verified:** the BullMQ round-trip itself — enqueue, consume, retry, schedule — has no
> Redis to run against. Everything around it is tested (job identity, schedules, quota, handlers,
> authority, JobRun bookkeeping, graceful degradation). The first thing to do when `REDIS_URL`
> arrives is start the worker and scheduler and watch a real job flow through.
