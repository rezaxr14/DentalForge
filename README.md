# TraceForge

Research-prototype workbench over real Dental-Agent artifacts (agent traces,
zero-shot evals, YOLO pre-labels, annotations). **Research prototype, not for
clinical use.**

Status: every page and worker capability described below is implemented and
covered by tests. SFT and GRPO training have **not** been run, so `/training`
shows both as "Not run yet". Decisions are recorded in `docs/adr/`
(ADR-0001 through ADR-0031).

**What the traces are.** The 38 demo traces are teacher-generated SFT training
data: a frontier LLM produced them in a tool loop with ground-truth guidance,
and a different model family verified the format. They are supervision data, not
a trained model's performance; model numbers appear only on `/evals`.

## Live demo

**https://dentalforge-app.vercel.app** - Next.js app on Vercel, Postgres on
Supabase. Start at [`/status`](https://dentalforge-app.vercel.app/status) to see
the capability ladder (database, worker mode, Redis, storage), then browse
traces, evals, labels, quality, and rewards. The deployment is verified with
`pnpm smoke:prod` (69 checks: pages, APIs, worker-token rejection, security
headers, CSP, strict console, axe). Public artifacts are DENTEX-derived only;
the Tufts data never leaves local development. Research prototype, not for
clinical use. No Python worker is connected to the public demo, so live runs
fall back to replay. The label editor can still pre-label on your own machine:
the button in `/labels/1` downloads the DENTEX-only YOLOv8m ONNX graph (49.5 MB,
cached after the first click) and runs it in a Web Worker — about 4.7 s per
image on a laptop, marked `browser_approx` and never presented as a worker
result. A Vercel Cron clears visitor-created annotations and demo
users nightly (the seeded data stays); `pnpm demo:seed --reset` rebuilds the
data from the committed bundle.

## Screenshots

| Page | Light | Dark | Mobile |
|------|-------|------|--------|
| Landing | ![Landing](docs/screenshots/landing-light.png) | ![Landing dark](docs/screenshots/landing-dark.png) | — |
| Trace Explorer | ![Traces](docs/screenshots/traces-light.png) | — | ![Traces mobile](docs/screenshots/traces-mobile.png) |
| Trace Detail (case 255) | ![Trace detail](docs/screenshots/trace-detail-light.png) | ![Trace detail dark](docs/screenshots/trace-detail-dark.png) | ![Trace detail mobile](docs/screenshots/trace-detail-mobile.png) |
| Eval Hub | ![Evals](docs/screenshots/evals-light.png) | — | — |
| Eval Detail | ![Eval detail](docs/screenshots/eval-detail-light.png) | — | — |
| Live Agent (replay) | ![Agent](docs/screenshots/agent-light.png) | ![Agent dark](docs/screenshots/agent-dark.png) | ![Agent mobile](docs/screenshots/agent-mobile.png) |
| Training Hub | ![Training](docs/screenshots/training-light.png) | — | — |
| Data & Licences | ![About data](docs/screenshots/about-data-light.png) | — | — |

All screenshots are captured by Playwright against the production build with
strict console error and horizontal overflow checks (`scripts/capture-screenshots.mjs`).

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Next.js App (Vercel)                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │  /traces    │  │  /evals     │  │  /agent     │  ...        │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│         │                │                │                     │
│         └────────────────┼────────────────┘                     │
│                          ▼                                     │
│              ┌─────────────────────┐                           │
│              │   DataSource        │                           │
│              │  (fixture / postgres)                            │
│              └──────────┬──────────┘                           │
└─────────────────────────┼──────────────────────────────────────┘
                          │
         ┌────────────────┼────────────────┐
         ▼                ▼                ▼
┌────────────────┐ ┌────────────┐ ┌────────────────┐
│  Supabase      │ │  Local     │ │  R2 / Blob     │
│  Postgres      │ │  fs        │ │  (when creds)  │
└────────────────┘ └────────────┘ └────────────────┘
```

### Run modes

| Mode | `TRACEFORGE_DATASOURCE` | `WORKER_MODE` | Data | Live runs |
|------|------------------------|---------------|------|-----------|
| Demo (production) | `postgres` | `live` | Seeded DENTEX from bundle | Only with a connected worker — none is, so replay |
| Local dev (fixture) | *(unset)* | `off` | Fixtures in `fixtures/` | ❌ Replay only |
| Local dev (postgres) | `postgres` | `off` | Local DB | ❌ Replay only |
| Live session | `postgres` | `live` | Your org | ✅ Queued jobs |

The capability ladder at `/status` reflects the active mode in real time.

### Data and licences

| Asset | Public? | Licence / note |
|-------|---------|----------------|
| DENTEX images (downscaled) | Yes | CC BY-NC-SA 4.0 — attribution, non-commercial, share-alike |
| DENTEX ground truth annotations | Yes | Same licence |
| Traces on DENTEX (model outputs, tool renders) | Yes, sanitized | Derived from DENTEX; provider terms must allow publishing |
| Zero-shot eval runs (8 tracked) | Yes | Already public in VLM-DENTAL; sanitized |
| Tufts images, traces, evals, weights | **Never** | Terms unverified; guarded by build (fails on `tufts` markers) |
| YOLO DENTEX-only weights (ONNX) | Yes, served from this site | 49.5 MiB fp16 export of the DENTEX-only fold-0 checkpoint (`public/models/yolo/`); AGPL-3.0 weights + DENTEX non-commercial terms - research use only (ADR-0027) |
| Multi-dataset YOLO weights | No | Until Tufts terms confirmed |
| Base model weights (Qwen, Llama, etc.) | No | Reference model ids only |
| Secrets, tokens, absolute paths, usernames | Never | Canary tests in `tests/python/test_demo_build.py`, run in CI |

The `/about-data` page shows the full notice with citations.

## Quickstart

```bash
pnpm install
pnpm dev        # http://localhost:3000 (fixture mode)
```

To run against a local Postgres with the demo data:

```bash
# 1. Start Postgres (e.g. Supabase local or Docker)
# 2. Set DATABASE_URL in .env.local
# 3. Build the demo bundle and seed
pnpm demo:build
pnpm demo:seed --reset
# 4. Run with postgres data source
TRACEFORGE_DATASOURCE=postgres pnpm dev
```

## Quality gates (also run in CI)

```bash
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint
pnpm test        # vitest run
pnpm ci          # all three
pnpm build       # production build (self-hosted Geist, no Google Fonts fetch)
```

## Browser tests (Playwright + axe)

Against the **production build** (`pnpm build` first). Each spec boots its own
`next start` with an explicit environment matrix (DB down, worker off, Redis
unreachable, failing storage).

```bash
pnpm exec playwright install chromium   # once
pnpm build
pnpm e2e:browser                        # Postgres on localhost:5433 (or E2E_DATABASE_URL)
```

They cover: every page under five degraded shapes, the worker-token UI (create →
shown once → copy → revoke), hydration with existing local state, and an axe
WCAG A/AA pass in light and dark. Where Playwright's browser download is
blocked, set `PW_CHROMIUM_PATH` to any Chromium binary (and `PW_CHROMIUM_ARGS`,
e.g. `--no-sandbox`, inside a container).

## Worker tests

```bash
pnpm e2e:worker                         # contract + handler tests with real worker
```

## Learn More (TraceForge docs)

- [`docs/adr/`](./docs/adr/) — ADR-0001 through ADR-0031 (schemas, parity, leak-definition fix, worker contract, ingest, demo bundle, hardening, deployment, VLM compatibility)
- [`docs/verification.md`](./docs/verification.md) — the end-to-end proofs of the worker and VLM-DENTAL connection, with the exact commands and their exit codes
- [`docs/live-demo.md`](./docs/live-demo.md) — what the deployed demo shows and how to rebuild it
- Data honesty: directive leak = assistant text matching VLM-DENTAL `LEAK_PATTERNS` (**0 / 5,454**); teacher scaffold in stored user messages is expected setup (5,454 / 5,454) — see ADR-0006.

## Deploy on Vercel

Deployed project: Vercel project `dentalforge-app` (its current build status is
in [`docs/verification.md`](./docs/verification.md), section 10), backed by a
Supabase Postgres database. Required production
env: `DATABASE_URL` (Supabase pooler), `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`,
`INVITE_SIGNING_SECRET`, `TRACEFORGE_DATASOURCE=postgres`, `DEMO_ORG_SLUG=demo`
(the anonymous demo reads that org), `CRON_SECRET` (Vercel Cron sends it as a
bearer token to `/api/demo/reset`), `WORKER_MODE=live`.
Secrets must be unique — the app refuses to boot with the public dev/example
values (see `src/shared/config/env.ts`). See [`docs/supabase.md`](./docs/supabase.md)
for the database runbook.

Standard Next.js deploy. The project is linked to this repository with `main` as
the production branch, so a push to `main` deploys and the production URL is
re-aliased automatically. Builds are self-hosted (Geist via the `geist` package,
no Google Fonts fetch). `WORKER_MODE` defaults to `off`; never set `HF_TOKEN` on
Vercel (local import scripts only). Storage is currently the ephemeral local
adapter, so uploads do not persist across deploys — configure R2 before relying
on uploads.