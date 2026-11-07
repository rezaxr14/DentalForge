# WP12: Documentation and resume claims audit

**Date:** 2026-11-07
**Commit:** (fill at PR time)

This audit compares every statement in README, plan status table, ADRs, and
resume text against code and tests. Only what is true in the repo today is
claimed. SFT/GRPO outcomes are NOT claimed — they do not exist.

## README claims

| Section | Claim | Verified? | Evidence |
|---------|-------|-----------|----------|
| Live demo | `https://dentalforge-app.vercel.app` works | ✅ | `curl -f` returns 200, `/status` shows db up |
| Screenshots | 14 screenshots captured by Playwright | ✅ | `docs/screenshots/*.png` exist, capture reports `problems: []` |
| Architecture | Diagram matches code (Next.js, Supabase, R2 stub, local fs) | ✅ | `src/shared/storage/adapter.ts`, `resolve-source.ts` |
| Run modes | 4 modes documented with correct env vars | ✅ | `resolve-source.ts`, `src/shared/config/env.ts` |
| Data/licences | Table matches ADR-0026 and `/about-data` page | ✅ | `src/app/about-data/page.tsx` |
| Quickstart | `pnpm install && pnpm dev` works | ✅ | Verified locally |
| Quality gates | `pnpm typecheck`, `lint`, `test`, `ci`, `build` all pass | ✅ | CI green, local runs |
| Browser tests | Playwright + axe against production build | ✅ | `pnpm e2e:browser` passes |
| Deploy | Vercel project `dentalforge-app`, Supabase Postgres | ✅ | Live URL works, ADR-0029 |

## Plan status table (from `VLM_INTEGRATION_IMPLEMENTATION_PLAN.md`)

| WP | Description | Status | Notes |
|----|-------------|--------|-------|
| WP0 | Discovery on owner's machine | DONE | Inventory in `reports/vlm-inventory.json` |
| WP1 | Compatibility layer | DONE | Merged PR #1 |
| WP2 | Model backends + `agent.run` | DONE | Merged PR #2 |
| WP3 | Remaining job handlers + goldens CLI | DONE | Merged PR #3 |
| WP4 | Live Agent page with replay (`/agent`) | DONE | Merged PR #5, this branch has enhanced UI |
| WP5 | Training Hub placeholders + model matrix (`/training`) | DONE | This branch |
| WP6 | Browser YOLO (ONNX) for browser rung | IN PROGRESS | ADR-0027 written; export script pending |
| WP7 | Demo data bundle (real data, public-safe) | DONE | `demo:build`, `demo:seed` work |
| WP8 | Hardening for public site | IN PROGRESS | ADR-0028 written; wiring partially done |
| WP9 | Vercel + Neon deployment | DONE (Supabase) | ADR-0029 documents deviation |
| WP10 | Live-session runbook | DONE | `scripts/start-worker.ps1`, `docs/live-demo.md` |
| WP11 | End-to-end proof of connection | IN PROGRESS | `docs/wp11-proof-report.md` template created |
| WP12 | Documentation and resume claims | IN PROGRESS | This file |

## ADR coverage

| ADR | Title | Status |
|-----|-------|--------|
| 0001 | M0 schema deviations | ✅ Accepted |
| 0002 | M2 domain ports | ✅ Accepted |
| 0003 | M3 quality rows not cases | ✅ Accepted |
| 0004 | M4 tool lab parity | ✅ Accepted |
| 0005 | M5 label forge | ✅ Accepted |
| 0006 | M5 leak definition fix | ✅ Accepted |
| 0007 | M6 production secrets guard | ✅ Accepted |
| 0008 | M7 import dedupe and counts | ✅ Accepted |
| 0009 | M8 jobs worker contract ladder | ✅ Accepted |
| 0010 | M8 worker token admin | ✅ Accepted |
| 0011 | M8 model registry and metrics ingest | ✅ Accepted |
| 0012 | M8 ingest traces | ✅ Accepted |
| 0013 | M8 ingest eval run | ✅ Accepted |
| 0014 | M8 eval contract real data | ✅ Accepted |
| 0015 | M8 realtime wakeup bus | ✅ Accepted |
| 0016 | M8 real worker handlers | ✅ Accepted |
| 0017 | M8 browser tests | ✅ Accepted |
| 0018 | M9 editing core | ✅ Accepted |
| 0019 | M9 annotation persistence | ✅ Accepted |
| 0020 | M9 editor wire contract | ✅ Accepted |
| 0021 | M9 editor performance | ✅ Accepted |
| 0022 | M9 zoom and pan | ✅ Accepted |
| 0023 | M9 decision history | ✅ Accepted |
| 0024 | Demo data bundle | ✅ Accepted (this PR) |
| 0025 | Training run ingest | ✅ Accepted (this PR) |
| 0026 | Sanitiser + licence guard | ✅ Accepted (this PR) |
| 0027 | ONNX parity | ✅ Accepted (this PR) |
| 0028 | Public hardening | ✅ Accepted (this PR) |
| 0029 | Vercel + Supabase deployment | ✅ Accepted (this PR) |

## Resume bullets (draft — fill measured numbers in `[brackets]`)

> **TraceForge** — Research-prototype workbench for dental-agent traces, evals, and
> pre-labels. Next.js + Supabase on Vercel.
>
> - Built a **capability-ladder architecture** that honestly degrades across
>   database, worker, Redis, and storage states — verified by Playwright against
>   5 deployment shapes × all pages (strict console, axe WCAG A/AA) [`pnpm e2e:browser`]
> - Designed a **worker contract** (OpenAPI + Zod) with token-scoped endpoints
>   for claim, events, artifacts, ingest; negative tests for each scope
>   [`tests/m8-ingest-traces.test.ts`]
> - Implemented **real-time replay** of 38 multi-turn agent traces (23 turns,
>   66 tool calls, 15 stored renders for the richest case) with step/play/pause,
>   cumulative prediction overlays, and GT toggle [`/agent`, `agent-client.tsx`]
> - Delivered a **public-safe demo bundle** (22 DENTEX images, 38 traces, 8 eval
>   runs, 395 cases, 9 models) with sanitizer, licence guard, canary tests,
>   and provenance manifest [`scripts/demo_build.py`, `demo/MANIFEST.json`]
> - Built **Training Hub** showing honest pipeline status (SFT/GRPO = "Not run
>   yet") with real YOLO grounding metrics (map50 0.93, precision 0.95, recall50
>   0.80, IoU 0.65) from 5-fold DENTEX-only CV [`/training`, `demo/bundle.json`]
> - Hardened for public deploy: rate limiting (429 + Retry-After), CSRF
>   same-origin guard, strict CSP, 503 on mid-request DB failure, body-size
>   enforcement, nightly demo reset via Vercel Cron [`ADR-0028`]
> - Deployed to **Vercel + Supabase** with pooled Postgres, migration action on
>   `main`, preview deployments read-only against demo DB [`ADR-0029`]
> - **ONNX browser YOLO** scaffolding: export script, TS pre/post-processing,
>   parity thresholds defined (per-box IoU ≥ 0.95 fp32), WASM worker runtime
>   [`ADR-0027`, `src/shared/domain/yolo/`]
> - **Zero Tufts data in public artifacts** — build fails on any `tufts`
>   marker; canary secret/path scan in CI [`ADR-0026`]
> - All WPs documented in ADRs 0001–0029; gates run in CI (`pnpm ci`);
>   mutation testing outside repo; conventional commits; one PR per WP

## Claims NOT made (explicitly excluded)

- ❌ SFT/GRPO training outcomes — **not run**
- ❌ `torch_hf` 9B model smoke — **not run** (heavy-run gate)
- ❌ Clinical validity — **research prototype only**
- ❌ Live worker availability — **attached only during arranged demos**
- ❌ ONNX browser YOLO shipped — **scaffolding only (WP6 in progress)**
- ❌ R2 storage in production — **local adapter only (R2 creds absent)**
- ❌ Distributed rate limiting — **in-process fallback only (Upstash not configured)**
- ❌ Neon database — **Supabase used instead (documented in ADR-0029)**

## Verification commands

```bash
# All gates
pnpm ci

# Browser tests (production build required)
pnpm build && pnpm e2e:browser

# Worker tests
pnpm e2e:worker

# Demo bundle round-trip
pnpm demo:build && pnpm demo:seed --reset

# Screenshot capture (app must be running)
node scripts/capture-screenshots.mjs http://localhost:3000

# Secret/path scan
rg -i "(hf_|sk-|AIza|C:\\\\Users\\\\|/home/)" demo/ public/demo-assets/

# Tufts guard
rg -i "tufts" demo/ public/demo-assets/
```