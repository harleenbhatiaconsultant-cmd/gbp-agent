# GBP Growth Agent — Development Plan

**Status:** Proposal. Nothing below has been built yet.
**Companion document:** [ARCHITECTURE.md](ARCHITECTURE.md)
**Last updated:** 2026-08-19

---

## 1. Current state of the repository

| Item | State |
|---|---|
| Project directory | `C:\Users\HP\gbp-growth-agent` — created for this plan, otherwise empty |
| Git | **Not initialised** (no repo anywhere in the home directory) |
| Node / npm | v24.16.0 / 11.13.0 — fine for Next.js |
| PostgreSQL | **16, installed and running** — portable install at `C:\Users\HP\pgportable\pgsql`, data dir `C:\Users\HP\pgdata`, port 5432. Usable immediately as the dev database. |
| Redis | **Not installed** — required by BullMQ from Phase 4 onward. See §7. |
| Docker | Not installed, and not required given the above |
| Google Cloud project | Not created |
| GBP API access | Not requested — **this is the critical path, see §2** |

---

## 2. Do this before writing any code

These are blocking, external, and slow. They cost nothing to start and gate everything downstream.

| # | Action | Owner | Why it blocks |
|---|---|---|---|
| **B1** | Create a Google Cloud project; enable the Business Profile API family + Cloud Pub/Sub | You | Nothing GBP-related can be called without it |
| **B2** | Configure the OAuth consent screen (external), add the `business.manage` scope, add test users | You | OAuth is unusable before this; scope requires verification for public launch |
| **B3** | **Submit the GBP "Basic API Access" request form** from an account that owns/manages a real, verified GBP that is 60+ days old | You | Quota is **0 QPM** until approved. Approval takes weeks and rejection-then-reapply is common. Start today. |
| **B4** | Decide the rank-tracking provider (DataForSEO / SerpApi / other licensed geo-grid API) and open an account | You | Phase 7 depends on it; pricing shapes your plan tiers |
| **B5** | Decide Redis hosting (see §7) | Joint | Phase 4 depends on it |
| **B6** | Pick one real GBP location you control as the development/test profile | You | There is no Google sandbox. All realistic testing needs a real profile plus `validateOnly` |

**Reality check on B3:** the entire product's write capability sits behind this approval. Until it
lands, Phases 1–3 (which are read-heavy or offline) can proceed, and `GBP_WRITE_MODE=validate_only`
keeps every write path exercised without touching a live profile.

---

## 3. MVP definition

**MVP = the smallest thing you can charge for and defend in a sales call.** From your numbered
requirements list, MVP covers items 1–6, 8, 9, 10, 14 and part of 16.

### In MVP

| # | Module | Maps to requirement |
|---|---|---|
| M1 | Auth, organizations, memberships, RBAC, multi-tenancy | 16 |
| M2 | Google OAuth connection + encrypted token storage | 1 |
| M3 | Location import + snapshotting + resync | 2 |
| M4 | Audit rule engine + health score + issue list | 3, 4 |
| M5 | Recommendations (rule-based, plus AI where language is needed) | 5 |
| M6 | Policy engine + approval queue + change execution + change log | 6, 14 |
| M7 | Review monitoring + AI response drafts (approval-gated) | 8, 9 |
| M8 | Performance metrics import + charts | 10 |
| M9 | Dashboard (health score, open issues, recent changes, metric trend) | — |

### Deliberately after MVP

| # | Module | Requirement | Why deferred |
|---|---|---|---|
| M10 | GBP post management + scheduling | 7 | Real value, but not needed to prove the core loop. Ships immediately after MVP. |
| M11 | Local keyword rank tracking (geo-grid) | 11 | External paid dependency; big cost centre; needs the rest working first |
| M12 | Competitor monitoring | 12 | Depends on Places API + ToS handling |
| M13 | Website local SEO audit | 13 | Separate subsystem (crawler); reuses the findings model |
| M14 | Client reports | 15 | Needs several phases of data to report *on* |
| M15 | Agency white-label | 17 | Modelled in the schema now, built when you have agency customers |
| M16 | Subscriptions & billing | 18 | Build when you have someone to bill |

**Note on M4 as a standalone product:** the audit engine alone is sellable as a paid one-off audit,
before any write capability exists. That is your revenue bridge while B3 is pending, and it matches
the "free instant audit" hook in your roadmap.

---

## 4. Phase plan

Each phase is a separate instruction to me. **Each ends with a working, reviewable increment** —
no phase leaves the tree half-migrated or non-building.

### Phase 0 — Foundation
Scaffold Next.js + TypeScript + Tailwind + shadcn/ui. `git init`. Prisma connected to the local
Postgres 16. Zod-validated env loader that fails fast. Base layout, logger, error handling
conventions, Vitest. No product features.
**Exit:** `npm run dev` serves an app shell; `npx prisma migrate dev` runs clean against local Postgres.

### Phase 1 — Tenancy & auth (M1)
`Organization`, `User`, `Membership`, `Invitation`, `AuditEvent`. Auth.js sign-in. `TenantContext`
resolution, RBAC helpers, the Prisma tenant-scoping extension, org switcher, members & invite UI.
**Exit:** two orgs exist; a user in org A provably cannot read org B (integration test asserts 404).

### Phase 2 — Google connection (M2)
OAuth connect flow with PKCE + signed state, AES-256-GCM token encryption, refresh handling,
`GoogleConnection` lifecycle (connect / status / reconnect / disconnect + revoke), the `GbpProvider`
interface, and `GoogleDirectProvider` covering Account Management reads.
**Exit:** connect a real Google account, list its GBP accounts in the UI, disconnect, and confirm the
token is revoked at Google and destroyed locally.
**Requires:** B1, B2, and at least test-user access.

### Phase 3 — Locations & snapshots (M3)
Business Information reads, location import, `LocationSnapshot` with content hashing, manual resync,
location list + detail UI, drift detection between snapshots.
**Exit:** real locations imported; re-running sync creates a new snapshot only when content actually changed.

### Phase 4 — Job infrastructure
BullMQ queues, the standalone worker entrypoint, repeatable schedules, `JobRun` observability, the
quota governor (10 edits/min/profile; global QPM), retries with backoff, and typed Google error mapping.
**Exit:** scheduled daily sync runs in the worker, is visible in the ops UI, and survives a restart
without duplicating work.
**Requires:** B5 (Redis).

### Phase 5 — Audit engine (M4) ← *the first sellable artefact*
Ruleset v1 as pure functions with fixture-based unit tests, covering: primary category present and
plausible, secondary category count, missing/incomplete NAP, hours completeness and special hours,
missing description or description quality, photo count and recency, review count/rating/velocity/
response rate, missing attributes and services, website link present, unverified or suspended state.
Health score with a published weighting, `AuditRun`/`AuditFinding` persistence, finding lifecycle
(open/resolved/ignored), and the audit UI.
**Exit:** run an audit on a real location and get a defensible, reproducible issue list and score.
**Sellable at this point:** paid manual audits.

### Phase 6 — Recommendations, policy, approval, execution, verification (M5, M6)
The `ActionType` registry and executors, the policy engine and every guardrail in ARCHITECTURE §7,
the `ChangeRequest` lifecycle, the approval queue UI, `validateOnly` dry runs, transactional
`ChangeLog`, idempotency, and the verification pass.
**Exit:** approve a low-risk fix and watch it go dry-run → applied → verified, with a complete audit
trail; a policy-violating proposal is blocked and recorded.
**Requires:** B3 approved for live writes. Everything is buildable and testable before that under
`validate_only`.

### Phase 7 — Reviews & AI drafts (M7)
Review sync (polling first, Pub/Sub push second), the review inbox, sentiment/topic classification,
AI response drafts routed through approval, and reply publication through the same execution pipeline.
**Exit:** a new review appears, a draft response is generated, a human approves, and the reply posts
to Google and is verified.

### Phase 8 — Performance + dashboard (M8, M9)
Performance API import, daily metric storage, trend charts, and the dashboard tying score, issues,
changes and metrics together.
**Exit:** a client-ready single screen.

### Phase 9 — Posts (M10)
Post composer, media, scheduling, AI-assisted copy through the claims linter, publish-and-verify.

### Phase 10 — Rank tracking (M11)
`RankProvider` integration, geo-grid scans, keyword management, grid heatmap and rank history.
**Requires:** B4.

### Phase 11 — Competitors + website audit (M12, M13)
Competitor tracking and snapshots; the bounded crawler and `scope = WEBSITE` findings folded into the
same score.

### Phase 12 — Reports (M14)
Scheduled and on-demand client reports built from `ChangeLog` + findings + metrics + rank history.
The change log is the proof-of-work that justifies retention.

### Phase 13 — White-label (M15) and Phase 14 — Billing (M16)
Branding, parent/child org elevation, seat permissions; then Stripe subscriptions, plan limits, and
metered usage.

---

## 5. Suggested sequencing

Phases 0–5 are the long pole and are entirely unblocked by B3. Two sensible orderings:

- **Revenue-first (recommended):** 0 → 1 → 2 → 3 → 5 → 4 → 6 …
  Reaching the audit engine sooner gives you something to sell and demo while API approval is pending.
  Job infrastructure slots in right before you need scheduled writes.
- **Infrastructure-first:** 0 → 1 → 2 → 3 → 4 → 5 → 6 …
  Cleaner, slightly slower to a sellable artefact.

---

## 6. Testing strategy

| Layer | Approach |
|---|---|
| Audit rules | Pure unit tests over recorded JSON fixtures. Every rule gets a positive and a negative case. This is the highest-value test surface in the product. |
| Policy guardrails | Unit tests per guardrail, including explicit adversarial cases: a keyword-stuffed title, a sentiment-filtered review request, a "#1 ranking" claim in generated copy. These must stay red-if-broken forever. |
| Tenant isolation | Integration tests asserting cross-tenant reads return 404 |
| Executors | Contract tests against a recorded-fixture provider, plus `validateOnly` runs against the real API |
| Integrations | Typed error-mapping tests; no live calls in CI |

---

## 7. Open decisions for you

| # | Decision | Options | My recommendation |
|---|---|---|---|
| D1 | Redis hosting | Managed (Upstash free tier) / Memurai on Windows / Redis in WSL2 / defer with an in-process runner | Managed Upstash — zero local setup, works from Windows over TLS, and matches production |
| D2 | Google client library | `googleapis` package vs. thin typed `fetch` clients | Thin `fetch` clients + `google-auth-library`. Smaller install, explicit error mapping, and reviews & posts need the legacy v4 endpoints anyway |
| D3 | Deployment target | Vercel + separate worker host / single VPS / Railway-style | Vercel for `web` + a small always-on host for `worker` — Vercel cannot host a long-lived BullMQ worker |
| D4 | Rank provider | DataForSEO / SerpApi / other | DataForSEO tends to be cheapest per geo-grid scan at volume; confirm against your own pricing tiers |
| D5 | Repo hosting | GitHub private / GitLab / local only | Whatever you already use; I'll `git init` locally in Phase 0 regardless |
| D6 | Project location | Keep at `C:\Users\HP\gbp-growth-agent` or move | Fine where it is; say if you'd rather it sat elsewhere |

---

## 8. Things I will not build, and why

These are listed so the boundary is explicit rather than discovered later:

- Any feature that gates review requests by predicted customer sentiment.
- Any generation of review *content* (as opposed to owner responses to real reviews).
- Business-name keyword insertion, or any automated title change without human approval.
- Fake locations, fake hours, or any profile value not traceable to a source the user supplied.
- Marketing copy, contract language, or in-app text promising a specific ranking outcome.
- Direct scraping of Google SERPs for rank data.

If a customer asks for one of these, the honest answer — and the one that keeps the platform alive —
is that the product refuses by design, and here is the compliant alternative.

---

## 9. What I need from you to start Phase 0

Just a go-ahead, plus your answers to D1 and D3 if you have preferences. Everything in Phase 0 runs
against the local Postgres that is already on this machine, needs no Google credentials, and installs
only the dependencies listed in ARCHITECTURE §11.
