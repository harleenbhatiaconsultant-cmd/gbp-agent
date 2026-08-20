# GBP Growth Agent — Architecture

**Status:** Proposal (pre-implementation). No application code has been written yet.
**Last updated:** 2026-08-19

---

## 0. What this product is (and what it is not)

GBP Growth Agent is a multi-tenant SaaS platform that helps businesses and agencies manage
Google Business Profile (GBP) listings and local SEO through a continuous loop:

```
OBSERVE  ->  RECOMMEND  ->  APPROVE  ->  EXECUTE  ->  VERIFY
(snapshot)   (rules + AI)  (human/policy) (Google API) (re-read & confirm)
     ^                                                        |
     +--------------------------------------------------------+
                        scheduled re-run
```

**Explicit non-goals — these are architectural constraints, not marketing copy:**

- The platform does **not** promise, guarantee, or imply any specific Google Maps / local pack
  ranking. Local pack position depends on searcher proximity, competitor density and Google's
  algorithm. A claims linter (see §7) blocks guarantee-style language in any AI-generated
  outward-facing copy.
- The platform does **not** implement review gating (screening customers by predicted sentiment
  before requesting a review), fake or incentivised review generation, fake locations, keyword
  stuffing, or business-name keyword manipulation. These are Google policy violations and, for
  review manipulation, carry FTC exposure. They are blocked in the policy engine, not merely
  omitted from the UI.
- The LLM never executes an external mutation. It can only *propose* a typed payload that must
  survive schema validation, policy evaluation, and an approval gate.

---

## 1. System overview

### 1.1 Runtime processes

Three deployable processes sharing one Postgres and one Redis:

| Process | Responsibility |
|---|---|
| **`web`** (Next.js) | UI (React Server Components), route handlers, OAuth callbacks, webhooks. Enqueues jobs. Never calls Google APIs on a user-blocking path except the OAuth exchange itself. |
| **`worker`** (Node, BullMQ) | All Google API traffic, audits, AI calls, crawls, rank scans, report generation, execution of approved changes. Owns retry/backoff and quota governance. |
| **`scheduler`** | Thin process (or a worker with repeatable jobs) that enqueues recurring work: daily sync, weekly audit, rank scans, token refresh sweep. |

Splitting `worker` from `web` is not optional: GBP write operations are rate-limited
(~10 edits/min/profile), long-running, and must be retryable with idempotency. Running them
inside a request handler would couple correctness to HTTP timeouts.

### 1.2 Layer boundaries

```
 app/ (RSC pages, route handlers)      <- no business logic, no Prisma, no fetch to Google
   |
 server/services/                      <- business logic, tenant-scoped, transaction owners
   |
 server/{audit,actions,policy,ai}/     <- rule engine, action executors, guardrails, prompts
   |
 server/integrations/                  <- Google / AI / rank / crawler clients (typed errors)
   |
 server/db/                            <- Prisma client + tenant-scoping extension
```

The rule enforced in review: **a React component never imports from `integrations/`, and a route
handler never imports Prisma directly.** Everything crosses through `services/`.

---

## 2. Multi-tenancy

`Organization` is the tenant root. Every tenant-owned row carries `organizationId`.

- **Identity:** `User` is global (one login, many orgs). `Membership(userId, organizationId, role)`
  grants access. Roles: `OWNER`, `ADMIN`, `EDITOR`, `VIEWER`.
- **TenantContext:** resolved once per request/job from the session + membership, then threaded
  explicitly: `{ organizationId, userId, role, plan }`. Services accept it as their first argument.
  Nothing reads the session deeper than the entry point.
- **Defense in depth:** a Prisma client extension (`$extends`) injects `organizationId` into the
  `where` clause for every tenant-scoped model on `findMany/findFirst/update/delete`, and throws if
  a tenant model is queried without a context. A forgotten `where` becomes an error, not a leak.
- **Agency / white-label (later phase, modelled now):** `Organization.type = AGENCY | BUSINESS` and
  `Organization.parentOrganizationId`. An agency user's `TenantContext` can be *elevated* to a child
  org through an explicit, audited `assumeChildOrg()` call — never by widening a query.

Locations, not organizations, are the unit of billing and of most work. A `Location` belongs to
exactly one `Organization`.

---

## 3. The action pipeline (the core safety design)

Five persisted, separately-auditable stages. Each has its own table, so you can always answer
"who decided this, who approved it, what exactly was sent, and did it land?"

### Stage 1 — Observation
- A sync job pulls current state from Google into an **immutable** `LocationSnapshot`
  (`rawPayload` + `contentHash`). Snapshots are never mutated; drift detection is a hash diff
  between consecutive snapshots.
- `Location` holds denormalised current values for querying and UI; the snapshot is the source of truth.

### Stage 2 — Diagnosis (deterministic, no LLM)
- `AuditRun` executes a versioned **ruleset** against one snapshot, producing `AuditFinding[]`.
- Each rule is a pure function: `(snapshot, context) => Finding[]`. Pure means unit-testable
  offline against fixtures, with zero network. This is what makes the audit defensible to a client.
- Every finding carries `severity`, `category`, `autoFixable`, `suggestedActionType`, `evidence`,
  and a stable `fingerprint`, so the same issue is tracked across runs (opened / resolved / ignored).
- The health score is computed from findings with a published weighting, and `rulesetVersion` pins
  it — so a score change is attributable to either the profile or a ruleset upgrade, never ambiguous.

### Stage 3 — Recommendation
- `Recommendation` rows, with `source = RULE | AI`.
- **Rule-sourced** recommendations carry a deterministic payload (e.g. "set primary category to X").
- **AI-sourced** recommendations are used where natural language is genuinely required: post copy,
  review responses, business description drafts, report narrative. The model is asked for a
  **structured object matching a Zod schema**, never for free text, and never for an action type
  outside a fixed enum.
- Every AI call is recorded in `AiInteraction` (provider, model, prompt version + hash, tokens, cost,
  latency). Cost per tenant is queryable; a runaway prompt is traceable.

### Stage 4 — Policy + Approval
A `Recommendation` becomes a `ChangeRequest` only after the **policy engine** runs:

1. **Schema validation** — payload must parse against the `ActionType`'s Zod schema.
2. **Compliance guardrails** (§7) — hard `BLOCK` decisions are recorded as `PolicyViolation` and
   the request is never queued.
3. **Risk scoring** — `LOW | MEDIUM | HIGH`. Risk is a property of the action type *plus the delta*
   (changing hours by 30 minutes is not the same as changing the primary category).
4. **Approval routing** — `HIGH` risk always requires a human `ADMIN`/`OWNER`. `LOW` risk may be
   auto-approved *only if* the org has explicitly enabled auto-apply for that action type.
   Default for every new org: auto-apply **off**.

`ChangeRequest.status`:
`DRAFT -> PENDING_APPROVAL -> APPROVED -> SCHEDULED -> EXECUTING -> EXECUTED | FAILED | ROLLED_BACK`
(or `REJECTED`).

### Stage 5 — Execution
- An `ActionExecutor` registry maps `ActionType` to a handler exposing:
  `schema`, `risk(payload, current)`, `dryRun(ctx)`, `apply(ctx)`, `captureBefore(ctx)`.
- **Dry run first.** The Business Information API supports `validateOnly` — there is no sandbox,
  so this is the only safe rehearsal. A global `GBP_WRITE_MODE=validate_only` env switch forces
  every executor into dry-run, and is the default for all non-production environments.
- `ChangeExecution` records each attempt: request payload, response, `beforeState`, `afterState`,
  error code. Retries create new attempt rows — history is append-only.
- **Idempotency:** every `ChangeRequest` carries a unique `idempotencyKey`. A retried job that finds
  a terminal execution for that key returns the prior result instead of re-sending to Google.
- The status transition and the `ChangeLog` write happen in the **same database transaction**, so
  "we applied it" and "we recorded it" cannot diverge.

### Stage 6 — Verification
- After a cooldown, a verification job re-reads the location from Google and compares observed
  state against `afterState`. Result stored in `Verification(matched, observedState)`.
- A mismatch (Google silently rejected it, or another editor / Google's own systems reverted it)
  reopens the finding and surfaces it in the UI. This closes the loop, and is what makes
  "continuous optimization" a truthful claim rather than a hopeful one.

---

## 4. Integration layer

### 4.1 Google — and the Path A / Path B question

Your roadmap weighs **Path A** (direct Google API access, weeks of approval) against **Path B**
(build on a vendor that already holds approved access). The architecture does not force the choice:
all Google traffic goes through a **`GbpProvider` interface** (`listAccounts`, `listLocations`,
`getLocation`, `updateLocation`, `listReviews`, `replyToReview`, `createPost`, `getPerformance`, …).

- `GoogleDirectProvider` — implements it against Google's own APIs (Path A).
- A `VendorProvider` can implement the same interface later (Path B) without touching services,
  the rule engine, the executors, or the schema.

**Recommendation:** build `GoogleDirectProvider` as the primary implementation, and **submit the GBP
API access request immediately** — it is the longest-lead item in the whole plan and it costs nothing
to start. Path B stays available as a fallback behind the same interface if approval stalls.

Every provider method returns a discriminated result and maps HTTP failures to typed errors
(`GbpAuthError`, `GbpQuotaError`, `GbpValidationError`, `GbpNotFoundError`, `GbpTransientError`)
so callers branch on meaning, not on string matching. Transient errors get exponential backoff with
jitter; quota errors defer the job; auth errors mark the `GoogleConnection` as needing reconnection
and notify the org.

### 4.2 Quota governance
A Redis-backed token bucket enforces, per connection and per location:
- the global QPM ceiling (default post-approval quota is ~300 QPM),
- **~10 edits/minute per profile** on Business Information writes.

The governor lives in the worker and is applied inside the provider, so no caller can bypass it.

### 4.3 AI provider abstraction

```ts
interface AiProvider {
  readonly id: 'anthropic' | 'openai';
  complete(req: AiRequest): Promise<AiResult<string>>;
  completeStructured<T>(req: AiStructuredRequest<T>): Promise<AiResult<T>>;  // Zod-validated
}
```

- Selected by `AI_PROVIDER`. Default implementation: `AnthropicProvider` using the official
  `@anthropic-ai/sdk`, model `claude-opus-5` for reasoning-heavy work and `claude-haiku-4-5`
  for high-volume classification (review sentiment and topic tagging).
- Prompts live in `server/ai/prompts/` as **versioned** modules; `promptVersion` is stored on every
  `AiInteraction`, so an output-quality regression is attributable to a specific prompt change.
- **Prompt-injection stance:** review text, competitor names and crawled website content are
  *untrusted input*. They are passed as delimited data with an explicit instruction that content
  inside the delimiters is data, never instructions. Model output is then re-validated by schema and
  by the claims linter before it is persisted or shown.
- Budget guard: per-org monthly spend cap; exceeding it degrades to rule-only recommendations rather
  than failing the audit.

### 4.4 Rank tracking
Google publishes **no** first-party "your position in the map pack" endpoint, and scraping Google
SERPs directly violates its Terms of Service. Local visibility is therefore sourced from a licensed
third-party provider behind a `RankProvider` interface
(`scanGrid(keyword, center, gridSize, radius)`), with `DataForSeoProvider` / `SerpApiProvider` as
swappable implementations. Results are stored as a geo-grid: one `RankScan` with many `RankPoint`
cells, so the UI can render the familiar grid heatmap and compute average rank / top-3 share over
time. This is a **metered cost centre** — scans are scheduled per plan tier, not run on demand for
everyone.

### 4.5 Website audit
A bounded internal crawler (own user agent, `robots.txt` respected, page cap, timeout, concurrency
limit) fetches the connected site and extracts title/H1/meta, schema.org types, and NAP occurrences.
Findings reuse the same `AuditFinding` table with `scope = WEBSITE`, so one health score and one
issue list cover both surfaces. Optional PageSpeed Insights and Search Console enrichment.

---

## 5. Background jobs

BullMQ over Redis. Queues are separated so a slow crawl cannot starve review syncing:

| Queue | Jobs | Default cadence |
|---|---|---|
| `sync` | `location.sync`, `reviews.sync`, `performance.sync` | daily (reviews: hourly on paid tiers, or Pub/Sub push) |
| `audit` | `audit.run`, `website.crawl` | weekly (audit), monthly (crawl) |
| `ai` | `recommendation.generate`, `review.draftResponse` | on demand / after audit |
| `execute` | `change.execute`, `change.verify`, `post.publish` | on approval; verify after cooldown |
| `rank` | `rank.scan` | weekly / plan-dependent |
| `report` | `report.generate`, `report.deliver` | monthly / scheduled |
| `maintenance` | `token.refreshSweep`, `snapshot.prune`, `job.reap` | hourly / nightly |

Every job is idempotent and keyed (`jobId = ${type}:${locationId}:${bucket}`), so a scheduler restart
cannot double-enqueue. `JobRun` rows give the ops UI real observability instead of "check the logs".

**Review notifications:** Google's Notifications API publishes to Cloud Pub/Sub. Push subscription →
`/api/webhooks/google-pubsub` → verify OIDC token → enqueue a targeted review sync. Polling remains
the fallback, so the product works before Pub/Sub is configured.

---

## 6. Data model (proposed)

Grouped by domain. Field lists are the significant columns, not exhaustive; every tenant table has
`id`, `organizationId`, `createdAt`, `updatedAt`.

### Tenancy & identity
| Model | Key fields |
|---|---|
| `Organization` | `name`, `slug` (unique), `type` (AGENCY\|BUSINESS), `parentOrganizationId?`, `plan`, `status`, `settings` (Json), `branding` (Json, white-label) |
| `User` | `email` (unique), `name`, `image`, `lastLoginAt` |
| `Membership` | `userId`, `organizationId`, `role`, unique(`userId`,`organizationId`) |
| `Invitation` | `email`, `role`, `tokenHash`, `expiresAt`, `acceptedAt` |
| `Account` / `Session` | Auth.js login records (**separate** from the GBP connection) |
| `ApiKey` | `name`, `keyHash`, `scopes[]`, `lastUsedAt`, `revokedAt` |
| `AuditEvent` | `actorUserId?`, `action`, `subjectType`, `subjectId`, `ip`, `userAgent`, `metadata` — security/authz trail, append-only |

### Google connection & locations
| Model | Key fields |
|---|---|
| `GoogleConnection` | `googleAccountEmail`, `encryptedRefreshToken`, `encryptionKeyVersion`, `accessTokenExpiresAt`, `scopes[]`, `status` (ACTIVE\|EXPIRED\|REVOKED\|NEEDS_RECONSENT), `lastRefreshAt`, `lastError` |
| `GbpAccount` | `connectionId`, `googleAccountName` ("accounts/123"), `accountType`, `role`, `verificationState` |
| `Location` | `gbpAccountId`, `googleLocationName` ("locations/456"), `storeCode`, `title`, `primaryCategoryId/Name`, `secondaryCategories` (Json), `address` (Json), `lat`/`lng`, `phone`, `websiteUri`, `regularHours`/`specialHours` (Json), `attributes` (Json), `profileDescription`, `serviceArea` (Json), `labels[]`, `verificationState`, `isSuspended`, `photoCount`, `lastSyncedAt`, `syncStatus`; unique(`organizationId`,`googleLocationName`) |
| `LocationSnapshot` | `locationId`, `capturedAt`, `source`, `rawPayload` (Json), `contentHash` — **immutable** |

### Audit, recommendation, change
| Model | Key fields |
|---|---|
| `AuditRun` | `locationId`, `snapshotId`, `rulesetVersion`, `status`, `healthScore`, `scoreBreakdown` (Json), `startedAt`, `completedAt`, `error?` |
| `AuditFinding` | `auditRunId`, `locationId`, `scope` (GBP\|WEBSITE), `ruleId`, `category`, `severity`, `status` (OPEN\|RESOLVED\|IGNORED\|WONT_FIX), `title`, `detail`, `evidence` (Json), `autoFixable`, `suggestedActionType?`, `fingerprint` |
| `Recommendation` | `locationId`, `findingId?`, `source` (RULE\|AI), `actionType`, `proposedPayload` (Json), `rationale`, `confidence`, `aiInteractionId?`, `status`, `expiresAt?` |
| `ChangeRequest` | `locationId`, `recommendationId?`, `actionType`, `payload` (Json), `riskLevel`, `policyDecision` (Json), `status`, `requestedByUserId?`, `approvedByUserId?`, `approvedAt?`, `scheduledFor?`, `idempotencyKey` (unique) |
| `ChangeExecution` | `changeRequestId`, `attempt`, `dryRun`, `requestPayload`, `responsePayload`, `beforeState`, `afterState`, `status`, `errorCode?`, `startedAt`, `finishedAt` |
| `ChangeLog` | `locationId`, `actor` (SYSTEM\|USER\|AI_ASSISTED), `actorUserId?`, `actionType`, `beforeState`, `afterState`, `changeRequestId?` — **the client-facing "what we did" history; append-only** |
| `Verification` | `changeExecutionId`, `verifiedAt`, `matched`, `observedState`, `notes?` |
| `PolicyViolation` | `subjectType`, `subjectId`, `ruleId`, `severity`, `detail` — every guardrail block, permanently recorded |

### Content: posts & reviews
| Model | Key fields |
|---|---|
| `GbpPost` | `locationId`, `googlePostName?`, `topicType` (STANDARD\|EVENT\|OFFER\|ALERT), `summary`, `mediaUrls[]`, `callToAction` (Json), `event`/`offer` (Json), `status` (DRAFT\|PENDING_APPROVAL\|SCHEDULED\|PUBLISHED\|FAILED\|DELETED), `scheduledFor?`, `publishedAt?`, `aiGenerated`, `changeRequestId?` |
| `Review` | `locationId`, `googleReviewId` (unique), `reviewerDisplayName`, `starRating`, `comment?`, `createTime`, `updateTime`, `replyComment?`, `replyUpdateTime?`, `sentiment?`, `topics[]`, `status` (NEW\|NEEDS_RESPONSE\|RESPONDED\|IGNORED) |
| `ReviewResponseDraft` | `reviewId`, `content`, `tone`, `aiInteractionId?`, `status` (DRAFT\|PENDING_APPROVAL\|APPROVED\|PUBLISHED\|REJECTED), `approvedByUserId?`, `publishedAt?`, `changeRequestId?` |

### Measurement
| Model | Key fields |
|---|---|
| `PerformanceMetric` | `locationId`, `date`, `metric` (enum: CALL_CLICKS, WEBSITE_CLICKS, DIRECTION_REQUESTS, IMPRESSIONS_MAPS_*, IMPRESSIONS_SEARCH_*, …), `value`; unique(`locationId`,`date`,`metric`) |
| `Keyword` | `locationId`, `phrase`, `locale`, `isPrimary`; unique(`locationId`,`phrase`,`locale`) |
| `RankScan` | `locationId`, `keywordId`, `provider`, `gridSize`, `radiusMeters`, `scannedAt`, `status`, `avgRank?`, `top3Share?`, `costCents?` |
| `RankPoint` | `rankScanId`, `lat`, `lng`, `rank?`, `matchedPlaceId?` |
| `Competitor` | `locationId`, `placeId`, `name`, `category?`, `websiteUrl?`, `isTracked` |
| `CompetitorSnapshot` | `competitorId`, `capturedAt`, `rating?`, `reviewCount?`, `categories` (Json), `photoCount?`, `postCadenceDays?` |

### Website
| Model | Key fields |
|---|---|
| `WebsiteProperty` | `locationId?`, `rootUrl`, `gscSiteUrl?`, `verifiedAt?` |
| `SiteCrawl` | `websitePropertyId`, `startedAt`, `finishedAt?`, `pagesCrawled`, `status` |
| `SitePage` | `siteCrawlId`, `url`, `statusCode`, `title?`, `metaDescription?`, `h1?`, `wordCount`, `schemaTypes[]`, `napFound` (Json) |

### Platform
| Model | Key fields |
|---|---|
| `AiInteraction` | `provider`, `model`, `purpose`, `promptVersion`, `promptHash`, `inputTokens`, `outputTokens`, `costUsdCents`, `latencyMs`, `status`, `errorMessage?` |
| `JobRun` | `queue`, `jobName`, `status`, `attempts`, `startedAt`, `finishedAt?`, `error?`, `payload` (Json) |
| `Report` | `locationIds[]`, `type`, `periodStart`, `periodEnd`, `status`, `storageKey?`, `generatedAt?`, `createdByUserId?` |
| `ReportSchedule` | `cadence`, `recipients[]`, `nextRunAt`, `template` |
| `Subscription` / `PlanLimit` / `UsageRecord` | billing phase — Stripe mirror, per-plan location & scan quotas, metered usage |

**Retention:** `LocationSnapshot` and `RankPoint` are the high-volume tables. Snapshots older than
N days are pruned except the first of each month and any snapshot referenced by an `AuditRun`.
`ChangeLog`, `AuditEvent` and `PolicyViolation` are never pruned — they are the compliance record.

**Consequence of append-only: a `User` cannot be deleted once they have acted.**
`AuditEvent.actorUserId` is declared `onDelete: SetNull`, and setting it null is an UPDATE, which
the append-only trigger refuses. Deleting such a user therefore fails at the database. This is the
correct outcome rather than a defect — attribution in a compliance trail must not evaporate — but
it means the GDPR erasure path is **anonymise, never delete**: overwrite the `User` row's email,
name and image with irreversible placeholders and keep the row so historical attribution stays
referentially intact. The same applies to `Organization`. Build that procedure deliberately in the
data-retention phase; until then, deletion will fail loudly instead of silently destroying records.

**Finding status semantics.** `AuditFinding.status` distinguishes `RESOLVED` (the profile no longer
exhibits the issue — it was genuinely fixed) from `SUPERSEDED` (a later audit re-observed the same
issue, so this row is simply no longer the newest observation). Collapsing the two would report a
fix on every audit run and make the client-facing history worthless.

---

## 7. Compliance guardrail engine

Runs **before** anything reaches the approval queue, and **again** on any AI-generated text before
persistence. Decisions: `ALLOW | REQUIRE_HUMAN | BLOCK`. Every non-ALLOW is written to
`PolicyViolation`.

| Guardrail | Rule |
|---|---|
| **Business name integrity** | Any `UPDATE_TITLE` is `REQUIRE_HUMAN` at minimum. `BLOCK` if the proposed title adds keywords, city names, or descriptors not present in the current verified name. The system never proposes a name change on its own. |
| **Review gating** | `BLOCK` any flow that filters, segments, or orders review requests by predicted or observed sentiment. There is no code path that can express "ask only happy customers". |
| **Review authorship** | The AI generates **responses to reviews, as the business owner**, only. Generating review *content*, or any text intended to be posted as a customer, is not an available action type. |
| **Ranking-claim linter** | Pattern + classifier pass over all AI output (posts, review replies, report narrative, emails) rejecting guarantee language: "guaranteed", "#1 ranking", "top of Google", "rank first", and similar. Applies to generated marketing copy too. |
| **Keyword stuffing** | Density and repetition checks on descriptions, services and post copy; `REQUIRE_HUMAN` above threshold, `BLOCK` at egregious levels. |
| **Category integrity** | Category changes must map to a real Google category ID fetched from the API. Category recommendations require human approval by default — a wrong primary category is the single most damaging profile error. |
| **Fabrication guard** | Hours, address, phone and attribute changes may only be proposed from a source the user supplied (website, GBP, user input) — never invented by the model. The payload carries a `sourceRef`; missing source = `BLOCK`. |
| **Rate & blast radius** | Caps changes per location per day, and blocks bulk operations spanning more than N locations without an explicit confirm step. |

---

## 8. Google APIs required

| API | Service | Used for | Notes |
|---|---|---|---|
| Google OAuth 2.0 / OpenID Connect | `accounts.google.com` | Login + GBP authorization | Scope `https://www.googleapis.com/auth/business.manage`; offline access for the refresh token |
| **Account Management API** | `mybusinessaccountmanagement.googleapis.com` | List accounts, admins, invitations | Entry point after OAuth |
| **Business Information API** | `mybusinessbusinessinformation.googleapis.com` | Locations, categories, attributes, hours, service areas — **all profile writes** | Supports `validateOnly`; ~10 edits/min/profile |
| **Business Profile Performance API** | `businessprofileperformance.googleapis.com` | Daily metrics: impressions, calls, direction requests, website clicks | Replaces the old Insights endpoints |
| **Notifications API** | `mybusinessnotifications.googleapis.com` | Register a Pub/Sub topic for new-review / update events | Requires Cloud Pub/Sub |
| **Verifications API** | `mybusinessverifications.googleapis.com` | Verification state & options | Read-mostly |
| **Google My Business API v4.9 (legacy)** | `mybusiness.googleapis.com` | **Reviews and Local Posts** | Important: reviews and posts were *not* migrated to the v1 services. Two API generations must coexist. |
| **Q&A API** | `mybusinessqanda.googleapis.com` | Questions & answers | Deprecated — build behind a feature flag, or skip |
| **Cloud Pub/Sub** | `pubsub.googleapis.com` | Receive review notifications | Service account + push subscription |
| *Optional:* Places API | `places.googleapis.com` | Competitor discovery & metadata | Caching restrictions in the Places ToS — store only what is permitted, refresh rather than archive |
| *Optional:* Search Console API | `searchconsole.googleapis.com` | Website query/impression data for the local SEO audit | Separate OAuth scope |
| *Optional:* PageSpeed Insights API | `pagespeedonline.googleapis.com` | Site performance signals | API key only |

**Access gate — start this first.** The Business Profile APIs require an approved access request
(the "Basic API Access" form), submitted from an account that is an owner or manager of a real,
verified GBP (60+ days old). Quota starts at 0 QPM until approved, typically rising to ~300 QPM.
There is no sandbox — `validateOnly` is the substitute. Budget several weeks and expect a possible
rejection-and-reapply cycle. **This is the critical path for the entire project.**

---

## 9. Security requirements

**Secrets**
- All secrets are server-only. A single Zod-validated `config/env.server.ts` parses `process.env` at
  boot and **fails fast**; it is import-guarded (`import 'server-only'`) so it can never be pulled
  into a client bundle. Only `NEXT_PUBLIC_*` values cross to the browser, and none of them are secrets.
- OAuth **refresh tokens are encrypted at rest** with AES-256-GCM using `TOKEN_ENCRYPTION_KEY`
  (32 bytes, base64), a per-record IV, and an `encryptionKeyVersion` column allowing rotation without
  downtime. Access tokens are held in memory/Redis with a TTL, never persisted in plaintext.
- Tokens are never selected into any API response, log line, or error message. The logger has a
  redaction list; the connection service exposes `getAuthorizedClient()` and nothing else.

**OAuth flow**
- Authorization code flow with **PKCE**, a signed short-TTL `state` bound to the session (CSRF), and
  exact redirect-URI matching. Token exchange happens only in the server route handler.
- Login OAuth and GBP-management OAuth are **separate consents**. Signing in must not silently grant
  profile-write access.
- Disconnect revokes the authorization at Google and destroys the stored credential by overwriting
  it, but **retains** the connection row, the imported locations and their change history. Deleting
  them would cascade into `ChangeLog`, which is append-only and refuses it — and rightly so: the
  record of what was changed on someone's listing must not disappear because an integration was
  unplugged. Purging a tenant is a separate, deliberate retention operation that archives the
  compliance trail first (Google API Services User Data Policy / Limited Use).

**Tenant isolation**
- Prisma tenant extension (§2) plus explicit `organizationId` predicates in services.
- Integration tests assert that a request from org A for an org B resource returns 404, not 403 —
  do not confirm existence.

**Authorization**
- RBAC checked **server-side in the service layer**, never only in the UI. Approving a change,
  managing connections and changing billing are `OWNER`/`ADMIN` only; `EDITOR` may draft; `VIEWER`
  is read-only. The approval endpoint re-verifies role and org at execution time, not at draft time.

**External calls**
- Every integration call: timeout, bounded retry with jitter, typed error mapping, a circuit breaker
  on repeated auth failure, and quota governance. No unbounded `fetch`.
- Idempotency keys on every write; a unique DB constraint makes double-apply impossible.

**Webhooks**
- Pub/Sub push verified by OIDC token audience + issuer check plus a shared verification token;
  Stripe by signature. Webhook handlers do no work — they validate, enqueue, and return 2xx fast.

**LLM safety**
- No tool-execution path from model to external API. Output is schema-constrained and re-validated.
- Untrusted content (reviews, crawled pages, competitor data) is delimited and labelled as data.
- All generated outward-facing copy passes the claims linter before storage.
- PII: reviewer names are personal data. Minimise what is sent to the AI provider, hold a DPA with
  that provider, and support export/erasure per org.

**Platform**
- HTTPS only, HSTS, `Secure`/`HttpOnly`/`SameSite=Lax` cookies, CSP, no inline scripts.
- Rate limiting per org and per IP on auth and API routes (Redis).
- Postgres encrypted at rest with point-in-time recovery; least-privilege DB user; reviewed migrations.
- Structured JSON logging with request/job correlation IDs; error reporting with PII scrubbing.
- Dependency audit + secret scanning in CI. `.env*` git-ignored except `.env.example`.

---

## 10. Folder structure (proposed)

```
gbp-growth-agent/
├─ prisma/
│  ├─ schema.prisma
│  ├─ migrations/
│  └─ seed.ts
├─ src/
│  ├─ app/
│  │  ├─ (marketing)/                     # public pages
│  │  ├─ (auth)/sign-in/ , verify/
│  │  ├─ (app)/[orgSlug]/
│  │  │  ├─ dashboard/
│  │  │  ├─ locations/
│  │  │  │  └─ [locationId]/{overview,audit,posts,reviews,performance,rankings,competitors,website,history}/
│  │  │  ├─ approvals/                    # the change-request queue
│  │  │  ├─ reports/
│  │  │  └─ settings/{organization,members,connections,billing,branding}/
│  │  └─ api/
│  │     ├─ auth/[...nextauth]/
│  │     ├─ google/oauth/{start,callback}/
│  │     ├─ webhooks/{google-pubsub,stripe}/
│  │     ├─ cron/[job]/                   # authenticated scheduler trigger
│  │     └─ v1/                           # public/agency API (later)
│  ├─ components/{ui,charts,forms,layout,features}/
│  ├─ server/
│  │  ├─ auth/          # Auth.js config, session, tenant-context, rbac
│  │  ├─ db/            # prisma client, tenant extension, tx helpers
│  │  ├─ services/      # organizations, connections, locations, audit, recommendations,
│  │  │                 # changes, posts, reviews, performance, rank, competitors,
│  │  │                 # website, reports, billing, notifications
│  │  ├─ audit/
│  │  │  ├─ engine.ts
│  │  │  ├─ scoring.ts
│  │  │  └─ rules/      # one file per rule, pure functions, fully unit-tested
│  │  ├─ actions/       # ActionType registry: one executor module per action
│  │  ├─ policy/        # guardrails, claims-linter, risk scoring, auto-approve policy
│  │  ├─ ai/            # provider abstraction, anthropic/, openai/, prompts/, structured.ts
│  │  ├─ integrations/
│  │  │  ├─ google/     # oauth, client, accounts, business-information, reviews,
│  │  │  │              # posts, performance, notifications, errors, quota
│  │  │  ├─ rank/       # provider iface + dataforseo/serpapi
│  │  │  └─ crawler/
│  │  ├─ jobs/          # queues, workers, schedules, handlers
│  │  ├─ crypto/        # AES-256-GCM token encryption + key rotation
│  │  └─ observability/ # logger, metrics, error reporting
│  ├─ schemas/          # Zod schemas shared client/server
│  ├─ lib/              # pure utilities, formatters
│  ├─ types/
│  └─ config/           # env.server.ts, env.client.ts, feature flags, plan limits
├─ worker/index.ts      # standalone worker entrypoint
├─ tests/{unit,integration,fixtures}/
├─ docs/
├─ ARCHITECTURE.md
├─ DEVELOPMENT_PLAN.md
└─ .env.example
```

---

## 11. Dependencies (and why)

Nothing here is speculative — each earns its place. Nothing gets installed until you approve the phase.

| Package | Why |
|---|---|
| `next`, `react`, `typescript` | Stated stack |
| `tailwindcss` + shadcn/ui deps (`class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, Radix primitives) | Stated stack; shadcn copies components into the repo rather than adding a UI dependency |
| `prisma`, `@prisma/client` | Stated stack |
| `zod` | Validation schemas — required by the stated principles and by structured AI output |
| `next-auth` (Auth.js v5) | Session/login. Chosen over hand-rolling because session security is not a place to be clever |
| `google-auth-library` | OAuth token exchange/refresh, and OIDC verification for Pub/Sub push |
| `googleapis` **or** thin `fetch` clients | *Decision deferred to Phase 2.* `googleapis` covers both the v1 services and legacy v4, but is a large dependency; typed `fetch` wrappers keep the install small and the error mapping explicit. Current recommendation: thin `fetch` clients plus `google-auth-library` for token handling only |
| `bullmq`, `ioredis` | Background jobs — required by the rate limits and long-running work |
| `@anthropic-ai/sdk` | Default AI provider |
| `pino` | Structured logging with redaction |
| `vitest` | Tests for the rule engine and executors |
| *Later phases:* `stripe`, `resend`/`nodemailer`, `recharts`, `@sentry/nextjs`, `cheerio` | Billing, email, charts, error reporting, HTML parsing for the crawler |

**Local infrastructure note:** Postgres 16 is already running on this machine
(`C:\Users\HP\pgportable`, data dir `C:\Users\HP\pgdata`, port 5432) — no container needed for the
database. **Redis is not installed.** Options, in order of preference for this environment: a managed
Redis (e.g. an Upstash free tier, which works over TLS from Windows), Memurai or Redis under WSL2,
or — for Phases 1–2 only — an in-process job runner behind the same queue interface, swapped for
BullMQ before any real Google writes happen.

---

## 12. Key decisions taken

1. **The worker process is separate from web from day one.** Retrofitting this later means rewriting
   every Google call site.
2. **Snapshots are immutable and audits are pure functions over them.** This makes the audit
   reproducible, testable without network, and defensible to a client asking "why did my score drop?".
3. **A `GbpProvider` interface** keeps Path A / Path B a swap, not a rewrite.
4. **The LLM proposes; the policy engine and a human dispose.** No tool-calling to Google, ever.
5. **Auto-apply defaults to off**, per org and per action type. The safe default is the one you ship.
6. **`validateOnly` everywhere by default** outside production, because Google has no sandbox.
7. **Rank tracking is a third-party, metered dependency** — designed in as a cost centre, never as a
   scrape.
