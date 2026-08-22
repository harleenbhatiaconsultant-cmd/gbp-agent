# Railway deployment shape

**Nothing is deployed yet.** This records the intended topology so the repository
stays deployable as it grows. Local development comes first.

## Services

Four Railway services in one project, all from this single repository:

| Service | Start command | Notes |
|---|---|---|
| **web** | `npm run start` | Next.js. Health check at `/api/health`. The only service with a public domain. Uses the root `railway.json` as-is. |
| **worker** | `npm run worker` | Consumes BullMQ queues. No public domain, no health check port. Owns all Google API writes. |
| **scheduler** | `npm run scheduler` | Enqueues repeatable jobs only. Single replica — never scale this above 1, or every schedule fires twice. |
| **Postgres** | — | Railway's managed Postgres plugin. Provides `DATABASE_URL`. |

Redis is **not** a Railway service in this design — D1 selected managed Upstash.
Set `REDIS_URL` to the Upstash `rediss://` connection string on the `worker`
and `scheduler` services.

Each service is created from the same repo and overrides only its start command
in the Railway dashboard (Settings → Deploy → Start Command). The shared
`railway.json` supplies the build.

## Environment variables by service

| Variable group | web | worker | scheduler |
|---|:--:|:--:|:--:|
| `DATABASE_URL` | ✓ | ✓ | ✓ |
| `REDIS_URL`, `QUEUE_PREFIX`, `WORKER_CONCURRENCY` | ✓ | ✓ | ✓ |
| `AUTH_SECRET`, `AUTH_URL`, `GOOGLE_LOGIN_*` | ✓ | | |
| `GOOGLE_OAUTH_*`, `TOKEN_ENCRYPTION_KEY` | ✓ | ✓ | |
| `GBP_WRITE_MODE`, `GBP_MAX_*` | ✓ | ✓ | ✓ |
| `AI_*`, `ANTHROPIC_API_KEY` | | ✓ | |
| `RANK_*`, `CRAWLER_*` | | ✓ | |
| `STRIPE_*` | ✓ | | |
| `NEXT_PUBLIC_*` | ✓ | | |

`web` needs the Google OAuth credentials because it performs the token exchange
in the callback route; `worker` needs them to refresh tokens for background syncs.

## Before the first deploy

1. **Migrations.** Add `npm run db:migrate:deploy` as a pre-deploy command on the
   `web` service only. Running it from three services concurrently would race on
   the migration lock.
2. **`tsx` is a production dependency — deliberately.** `worker` and `scheduler`
   start via `tsx`, and Railway prunes devDependencies for production installs, so
   it would not be there to run them.

   The alternative — a `tsc` build emitting to `dist/` — was rejected: the worker
   imports through `@/` path aliases, and plain `tsc` emits those unresolved, so
   Node cannot load them without adding `tsc-alias` or a bundler. `tsx` resolves
   tsconfig paths natively. The cost is carrying esbuild into the runtime image;
   the benefit is one fewer build step that can silently emit broken imports.
3. **`GBP_WRITE_MODE`.** Leave it at `validate_only` on the first production
   deploy. Flip it to `live` only after the GBP API access request is approved
   and a real change has been rehearsed end to end. The env loader refuses
   `live` unless `NODE_ENV=production`, so staging cannot mutate a real profile.
4. **`ENABLE_AUTO_APPLY`.** Keep `false`. It is refused outside production by the
   env loader, and even in production requires per-organization opt-in.
5. **Scheduler replicas.** Pin to 1.
