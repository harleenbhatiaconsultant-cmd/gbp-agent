# GBP Growth Agent

Google Business Profile management and local SEO optimization for businesses and agencies.

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — system design, data model, security requirements
- **[DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)** — phases, MVP scope, open decisions
- **[docs/DEPLOYMENT_RAILWAY.md](docs/DEPLOYMENT_RAILWAY.md)** — deployment topology (not deployed yet)

**The write path is built but gated shut.** Under the default configuration nothing can reach
a live business profile even with valid credentials loaded: every write is sent to Google with
`validateOnly=true`. That is asserted against the provider's actual call log, not inferred
from a flag. See *Safety defaults* below.

**Two integrations are built but unverified against the real thing**, both waiting on external
access: the BullMQ round-trip (needs `REDIS_URL`) and anything that talks to a real profile
(needs the Business Profile API access request approved).

Phase-by-phase status lives in exactly one place — [Status by phase](#status-by-phase). It is
deliberately not restated here, because a summary that enumerates phases is a second copy that
has to be kept in agreement with the first, and it will not be.

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

Two things that will bite you otherwise:

- Keep the log file **outside** the data directory. Postgres fsyncs the data directory on
  startup and will stall for 30 seconds retrying a log file it cannot open there.
- **Start it detached, not from a shell you are about to close.** The postmaster is a child of
  whatever launched it, so starting it from an attached or background shell means the server
  dies when that shell is torn down — which looks like a mysterious "connection refused" later.
  On Windows, `Start-Process -WindowStyle Hidden` on `pg_ctl` is the reliable way; installing it
  as a Windows service is the permanent fix.

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
| `npm run dev` | Dev server. Refuses to start if port 3000 is taken, rather than silently moving to 3001 |
| `npm run dev:force` | Same, but stops whatever holds the port first |
| `npm run worker` | Worker process. Idles unless REDIS_URL is set |
| `npm run scheduler` | Scheduler process. Single replica only |
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

Two defaults matter more than the rest, both asserted by tests:

- **`GBP_WRITE_MODE=validate_only`** — every Google write carries `validateOnly=true` and
  mutates nothing. Google offers no sandbox, so this is the only safe rehearsal. The env
  loader refuses `live` unless `NODE_ENV=production`.
- **`ENABLE_AUTO_APPLY=false`** — unattended changes require three independent conditions:
  the global flag, per-organization opt-in for that specific action type, and a LOW risk
  classification.

### Permanently human-approved actions

`UPDATE_TITLE`, `UPDATE_CATEGORIES` and `UPDATE_ADDRESS` can **never** be auto-applied,
whatever the flags say. These are settled decisions, not current defaults — the primary
category is the strongest ranking signal a profile has, a bad address write can pull a listing
into re-verification and offline, and name manipulation is an explicit Google policy violation.

They are pinned by [`tests/unit/always-human-actions.test.ts`](tests/unit/always-human-actions.test.ts),
which turns auto-apply **on** before asserting. That matters: with the flag off — the default,
and how every other test runs — `canAutoApply` refuses everything at the first check, so a test
there would pass even if the list were empty. The file also asserts a *non*-listed action IS
allowed, so a mock that failed to take is caught rather than making the rest vacuous.

### Separation of duties

The proposer can never approve their own change. Absolute — no flag, no plan tier, no
single-operator exemption, because an exception built for solo use outlives its usefulness. A
one-person organization must invite a second admin; the UI says so and links to Members rather
than showing a button that always fails. Rejecting your own proposal is still allowed.

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

This table is the single source of truth for what is built. Update it in the same commit as
the work it describes — a status table corrected later, when someone happens to notice, has
already misled whoever read it in between. `tests/unit/readme-consistency.test.ts` enforces the
structure and stops the phase list being duplicated into the summary again.

| Phase | Scope | State |
|---|---|---|
| 0 | Foundation, schema, safety defaults | done |
| 1 | Tenancy, auth, RBAC, invitations | done |
| 2 | Google OAuth connection, encrypted tokens | done — needs credentials to test against a real account |
| 3 | Location import, immutable snapshots | done — needs approved API access to test |
| 4 | BullMQ jobs, scheduling, quota governor | done — inactive until `REDIS_URL` is set |
| 5 | Audit rule engine, health score, findings | done |
| 6 | Executors, policy engine, approval queue | done — write path built, gate closed |
| — | Editors: categories, hours, address | done |
| 7 | Reviews sync, AI response drafts | not started |
| 8 | Performance metrics, dashboard | partial — dashboard exists, metrics import does not |
| 9 | GBP posts | not started |
| 10 | Local rank tracking (geo-grid) | not started — needs a paid provider |
| 11 | Competitors, website audit | not started |
| 12 | Client reports | not started |
| 13–14 | White-label, billing | not started |

**Blocked on external access, not on code:** the BullMQ round-trip (needs `REDIS_URL`) and
anything that talks to a real profile (needs the Business Profile API access request approved).

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

## Editors

Three editors propose changes into the approval queue. Each is shaped by the specific way its
field can go wrong.

| Editor | The failure mode it is built around |
|---|---|
| **Categories** | Ids are not free text — Google rejects anything outside its regional, localized taxonomy. So it searches Google and you pick, rather than typing a `gcid:` and hoping. Falls back to manual id entry when the taxonomy is unreachable, saying why. |
| **Hours** | The update mask replaces `regularHours` wholesale, so a day left out is not "unchanged" — it is **closed**. Seeded from published hours, every day always shown, and closing a currently-open day is called out before submission. Split shifts survive; collapsing them would discard half a restaurant's schedule. |
| **Address** | A bad write triggers re-verification and can take the listing offline. Shows a field-by-field diff before submission, and warns specifically on the two changes most likely to force re-verification: moving country, and adding an address to a service-area profile. |

All three seed from the **snapshot**, never the denormalized `Location` row. The policy engine
compares proposals against the snapshot, so an editor seeded from anything else could show a
state differing from the one the guardrails reason about — and its warnings would be wrong in
exactly the case that matters.
