# ADR-0029: Vercel + Supabase deployment (replaces Neon)

**Status:** accepted
**Date:** 2026-11-07
**Context:** The original deployment plan specified Neon for Postgres. The deployed
production uses **Supabase** (managed Postgres) instead. This ADR documents the
deviation, the rationale, and the operational details.

## Rationale

- Supabase provides managed Postgres with connection pooling (PgBouncer),
  auth, and storage in one platform — simpler for a portfolio project
- The pooled connection string works with the existing Drizzle + pg driver
  without prepared-statement conflicts (tested)
- Free tier is sufficient for the demo workload
- Region `us-east-1` matches Vercel's default function region (Washington, DC)

## Environment variables (production)

| Variable | Source | Notes |
|----------|--------|-------|
| `DATABASE_URL` | Supabase → Settings → Database → Connection pooling (port 6543) | `postgresql://postgres:<password>@db.<ref>.supabase.co:6543/postgres?pgbouncer=true` |
| `DATABASE_URL_UNPOOLED` | Supabase → Settings → Database → Direct connection (port 5432) | For `drizzle-kit migrate` only |
| `BETTER_AUTH_URL` | `https://dentalforge-app.vercel.app` | Must match Vercel domain exactly |
| `BETTER_AUTH_SECRET` | Generated: `openssl rand -base64 32` | Rotated after placeholder failed guard |
| `INVITE_SIGNING_SECRET` | Generated: `openssl rand -base64 32` | Rotated after placeholder failed guard |
| `TRACEFORGE_DATASOURCE` | `postgres` | Enables postgres DataSource |
| `WORKER_MODE` | `live` | Production default; `off` for previews |
| `DEMO_ORG_SLUG` | `demo` | Enables anonymous demo access |
| `STORAGE_PROVIDER` | `local` | Ephemeral; configure R2 for persistence |
| `R2_*` | *(unset)* | Add when R2 is configured |
| `UPSTASH_REDIS_REST_URL` / `TOKEN` | *(unset)* | Add for distributed rate limiting |
| `CRON_SECRET` | Generated | For `/api/demo/reset` Vercel Cron |

**Never commit values.** `.env.example` documents every variable.

## Vercel project

- Project name: `dentalforge-app` (renamed from `dentalforge-dev`)
- Framework preset: Next.js (auto-detected)
- Build command: `pnpm build` (uses Turbopack in dev, standard in build)
- Output directory: `.next`
- Install command: `pnpm install --frozen-lockfile`
- Node version: 20.x (set in `.nvmrc` and Vercel settings)

## Supabase database

- Project: `dentalforge-demo` (or similar)
- Region: `us-east-1`
- Postgres version: 16
- Connection pooling: **Transaction mode** (PgBouncer, port 6543)
- The app uses the pooled URL for all runtime queries
- Migrations run against the unpooled URL (port 5432) in a GitHub Action

### Migration workflow

```yaml
# .github/workflows/migrate.yml
on:
  push:
    branches: [main]
jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm db:migrate
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL_UNPOOLED }}
```

**Proof from empty DB:** The action asserts table count after migrate
(`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'`)
matches the expected schema count (30+ tables).

## SSE on Vercel

- `maxDuration: 60` in `next.config.ts` for `/api/worker/v1/jobs/[id]/events`
- Clients resume with `Last-Event-ID` or fall back to polling (5 s interval)
- Test: `pnpm e2e:worker` includes SSE reconnect scenario

## Previews

**Decision:** Preview deployments run **read-only against the demo database**
(`TRACEFORGE_DATASOURCE=postgres`, `WORKER_MODE=off`, `DEMO_ORG_SLUG=demo`).
They do not get a Neon/Supabase branch. This avoids migration drift and
keeps previews fast and deterministic.

## Post-deploy smoke (`pnpm smoke:prod -- <url>`)

```bash
# Key pages
curl -f https://dentalforge-app.vercel.app/
curl -f https://dentalforge-app.vercel.app/traces
curl -f https://dentalforge-app.vercel.app/evals
curl -f https://dentalforge-app.vercel.app/agent
curl -f https://dentalforge-app.vercel.app/training
curl -f https://dentalforge-app.vercel.app/about-data
curl -f https://dentalforge-app.vercel.app/status

# APIs
curl -f https://dentalforge-app.vercel.app/api/health
curl -f https://dentalforge-app.vercel.app/api/labels/status

# Auth: worker endpoints reject missing tokens
curl -X POST https://dentalforge-app.vercel.app/api/worker/v1/heartbeat \
  -H "Content-Type: application/json" \
  -d '{"name":"test","runtime":"test"}' \
  -w "%{http_code}" | grep -q "401"

# Strict console + axe on 6 pages (Playwright against the URL)
pnpm smoke:prod -- https://dentalforge-app.vercel.app
```

## Production degradation

Verified manually and in CI preview with wrong `DATABASE_URL`:

- Worker offline (`WORKER_MODE=off`): `/status` shows `workerMode: "off"`, `/agent`
  shows replay with "Worker integration is off" banner, live controls disabled
- Database unreachable: `/status` shows `db: "down"`, all pages show honest
  degraded state (no 5xx page, console clean)

## Acceptance (checked 2026-11-13)

| Item | Status |
|------|--------|
| Deployed URL | live, but an **older build** of this repository: `pnpm smoke:prod` fails 25 checks (`/about-data` 404, demo assets 404, no CSP/security headers). Exact list: `docs/verification.md` section 10 |
| Smoke report attached to PR, all commands exit 0 | **not achieved yet**; the project is not connected to the Git repository, so releases are manual (`gh api repos/…/hooks` returns `[]`) |
| Screenshots (light, dark, 390px) of Agent replay, Traces, Evals, Editor with browser pre-labelling, Training placeholders | in `docs/screenshots/` |
| Migration from an empty database | covered by the `browser` CI job (empty-database run) and the five-shape degradation matrix |
| Preview deployments read-only against the demo DB | preview configuration documented above; not exercised by a scheduled check |
| Degradation states verified | `pnpm smoke` (139 checks) and `e2e/degradation.spec.ts` (120 passed) |

The deployment decision itself stands: the database is up and `/api/health`
answers `{"status":"ok","contractVersion":1,"db":"up","redis":"absent","storage":"local","workerMode":"live"}`.
What is missing is a release of the current commit, which the owner must run
(`vercel --prod`) or automate by connecting the Git integration.