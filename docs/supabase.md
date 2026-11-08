# Supabase (managed Postgres)

TraceForge needs exactly one managed service to be a real deployment: Postgres. Supabase provides
it, and nothing else in the stack changes — the schema, the migrations in `drizzle/`, the Drizzle
client and Better Auth's Postgres adapter all work unchanged.

This file is the runbook. It is written to be followed by a human with a browser; it does not
contain secrets.

## 1. Pick the project

`supabase.com/dashboard` → the project (or **New project**). Note:

| What | Where |
| --- | --- |
| Project ref (20 chars, e.g. `abcdefghijklmnopqrst`) | Settings → General → Reference ID |
| Region | Settings → General → Region |
| DB password | Settings → Database → Reset database password (only shown once) |

This deployment uses the project **`dentalforge-dev`** (`bynvikqzzvmjtjgaeyfp`, `eu-central-1`).

The free tier pauses a project after ~1 week of inactivity, which is what the suspension email is
about. Any real traffic — or a scheduled `select 1` — keeps it awake. Once the app is deployed it
will not idle.

## 2. Get the two connection strings

Settings → Database → **Connection string** → URI.

* **App (`DATABASE_URL`)** — the *pooler*, port **6543** (transaction mode):

  ```
  postgresql://<role>.<ref>:<password>@aws-1-<region>.pooler.supabase.com:6543/postgres?sslmode=no-verify
  ```

  Transaction mode is what serverless needs: each request gets a connection only for its own
  statements, so a Vercel function fleet cannot exhaust Postgres' 60-connection limit.

* **Migrations (`DIRECT_URL`)** — the *same pooler host*, port **5432** (session mode). DDL and
  `drizzle-kit` need a session, not a transaction.

Two details that cost an hour if you guess them:

* **The pooler shard is not always `aws-0`.** For this project it is **`aws-1`**; connecting to
  `aws-0-…` fails with `tenant/user … not found`, which looks like a password problem but is not.
  Take the host from the dashboard's connection string rather than composing it.
* **`sslmode=require` fails with `self-signed certificate in certificate chain`.** Since
  `pg-connection-string` v3, `require` means *verify-full* (see the warning `pg` prints), and
  Supabase's pooler chain is not in Node's trust store. `sslmode=no-verify` encrypts without
  verifying the chain. To get real verification instead, download Supabase's `prod-ca-2021.crt` and
  pass it as `ssl.ca` in `src/shared/db/pg.ts` — that is the upgrade path, not a requirement today.

Do **not** use the direct `db.<ref>.supabase.co` host: it is IPv6-only (it does not even resolve on
an IPv4-only network) and unreachable from most CI runners and some serverless runtimes.

### The app role

The app connects as **`traceforge`**, not `postgres` — a dedicated, non-superuser login role with
DML on `public` and the `drizzle` baseline schema, and nothing else. Its password is generated
locally and written straight into `.env.local`; it is never committed, printed or pasted into a
chat. To rotate it: `alter role traceforge with password '<new>';` and update `.env.local`.

## 3. Apply the schema

```bash
export DIRECT_URL='postgresql://traceforge.<ref>:…@aws-1-<region>.pooler.supabase.com:5432/postgres?sslmode=no-verify'
pnpm db:migrate
```

`drizzle/` is the source of truth. A database that was created with `pnpm db:push` has the tables
but **no** `drizzle.__drizzle_migrations` baseline, so `db:migrate` would try to re-run `0000` and
fail on `relation "accounts" already exists`. This project has been baselined: all eight hashes
(`0000`–`0007`) are recorded, so `pnpm db:migrate` is a no-op today and future migrations apply
cleanly.

To baseline a different database that already has the schema, insert one row per migration into
`drizzle.__drizzle_migrations` with `hash = sha256(<file contents>)` and
`created_at = <journal entry's "when">`.

Verify:

```bash
psql "$DIRECT_URL" -c '\dt'
```

You should see `organizations`, `users`, `datasets`, `images`, `traces`, `jobs`, `job_events`,
`artifacts`, `workers`, `model_registry`, `training_runs`, `training_metrics`, `reward_samples`,
`eval_runs`, `eval_cases`, `annotations`, `review_decisions`, and the Better Auth tables
(`sessions`, `accounts`, `verifications`).

## 4. Point the app at it

```bash
# app: the transaction pooler
DATABASE_URL='postgresql://<role>.<ref>:<password>@aws-1-<region>.pooler.supabase.com:6543/postgres?sslmode=no-verify'
# migrations only: the same host in session mode
DIRECT_URL='postgresql://<role>.<ref>:<password>@aws-1-<region>.pooler.supabase.com:5432/postgres?sslmode=no-verify'
```

* `.env.local` for local runs against the hosted database (optional — the Docker database on
  port 5433 is the normal local target, and it is faster).
* The Vercel project's environment variables for the deployment. `DATABASE_URL` is required;
  `DIRECT_URL` is not read at runtime, so do not set it there.

The deployment lives at **https://dentalforge-app.vercel.app** (Vercel project
`dentalforge-app`). `/api/health` reports `db: up` and `workerMode: live` when the wiring is
correct; `/status` shows the same capability ladder in the UI.

`src/shared/db/pg.ts` asks `src/shared/db/ssl.ts` how to talk to Postgres, **from the URL alone**
(never from a CI flag, and independent of the `pg` version: `pg` lets a `sslmode` in the URL override
the `ssl` option, so `sslmode` is removed from the string handed to `pg` and `ssl` is passed
explicitly):

| URL | Connection |
|-----|-----------|
| `sslmode=no-verify` | TLS, certificate **not** verified (what this project uses with the pooler; §2 explains why `require` fails here and what the upgrade path is) |
| `sslmode=require` / `verify-ca` / `verify-full` | TLS, certificate verified |
| `sslmode=prefer` / `allow` | TLS, certificate verified (`pg` cannot fall back to plain TCP; a warning is logged) |
| `sslmode=disable` | no TLS |
| no `sslmode`, loopback or unix-socket host | no TLS (nothing to verify; this is what smoke, docker and a local demo use) |
| no `sslmode`, any other host | production: TLS verified; otherwise no TLS |

Tests: `tests/db-ssl.test.ts` (including a production-mode connection with no `CI` variable) and the
variant C check of `pnpm smoke`.

## 5. Nothing else is Supabase-specific

Deliberately:

* **No `@supabase/supabase-js`, no Supabase Auth, no Storage, no RLS.** Auth is Better Auth, files
  go through the storage adapter (local / R2), and tenant isolation is enforced in the repositories
  (`org_id` on every query) with tests for both the Postgres and in-memory stores.
* **The PostgREST roles have no grants.** Supabase creates `anon` and `authenticated` with access to
  `public`; this app never sends the anon key to a browser, so those grants were revoked
  (`revoke all privileges on all tables in schema public from anon, authenticated`). That closes
  Supabase's "RLS is disabled" advisor without enabling RLS, which would block the server-side
  connection the app actually uses.
* **No `supabase` CLI in the build.** The migrations are plain SQL owned by this repository, so a
  Supabase outage or a move to another Postgres changes nothing.

## Status

| Step | State |
| --- | --- |
| Repo prepared (`DIRECT_URL`, `db:*` scripts, this doc) | done |
| Project reachable, app role `traceforge` created and granted | done — verified `select current_user` → `traceforge` |
| Schema applied and baselined (`0000`–`0007`) | done — `pnpm db:migrate` is a no-op |
| `DATABASE_URL` / `DIRECT_URL` in `.env.local` | done — pooler `aws-1`, port 6543 / 5432 |
| PostgREST grants revoked (no RLS advisory) | done — `get_advisors` returns no lints |
| Vercel `DATABASE_URL` set | done — production/preview/development on `dentalforge-app` |
| Test fixtures wiped from the dev database | done — all app tables truncated, 0 rows |

The hosted database currently holds **no real data**: every organization has zero members, every
dataset is a `dentex` fixture row, and there are no users, jobs, traces or eval runs. A reset is
therefore safe whenever you want a clean slate.

