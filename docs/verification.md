# Verification: the worker and the VLM-DENTAL connection

This is the evidence behind the worker claims in the README. Every command below
was run on the date shown, with the exit code recorded. Where a proof has a
negative control, the control is listed next to it; a check that only ever
passes is not evidence.

## Environment

| | |
|---|---|
| Date | 2026-11-12 |
| OS | Windows 11 (`win32`) |
| Node / pnpm | v22.18.0 / 12.9.1 |
| Python | 3.12.3 |
| Postgres | Docker, `postgresql://traceforge:traceforge@localhost:15433/traceforge` |
| VLM-DENTAL | `../VLM-DENTAL`, HEAD `79b3e32`, `git status --porcelain` empty before and after every run |
| LM Studio | `http://localhost:1234/v1`, `qwen3.5-4b` loaded (3.65 GiB) |

Nothing here pins VLM-DENTAL to a commit: the worker probes the checkout on the
machine and advertises only what it finds. The commit above is provenance for
this run, not a requirement.

## 1. The contract, on both sides

```powershell
pnpm contract:validate
```

Exit code **0**. The command checks three things:

- `docs/worker-openapi.json` is byte-for-byte what the Zod contracts generate;
- `docs/worker-contract.md` is byte-for-byte what the Zod contracts render;
- the recording from the Python reference handlers validates against the
  published document with `jsonschema` (**9 passed**) **and** against the
  server's Zod schemas (**11 passed**).

Negative control: changing one event type in
`fixtures/worker/wp3-acceptance.json` from `"progress"` to `"bogus_event"` made
the same command exit **1** with `contract:validate: 2 check(s) FAILED` (the
Python and Zod sides both rejected it, 4 Zod tests failed). The file was
restored and verified by SHA-256.

## 2. Token scopes and tenant isolation

```powershell
$env:DATABASE_URL="postgresql://traceforge:traceforge@localhost:15433/traceforge"
pnpm exec vitest run tests/m8-token-admin.test.ts tests/m8-importer-scoping.test.ts `
  tests/m8-ingest-traces.test.ts tests/m8-ingest-api.test.ts tests/m8-worker-api.test.ts `
  tests/m8-worker-reads.test.ts tests/m8-jobs-repo.test.ts tests/m8-job-stream.test.ts `
  tests/m8-capability.test.ts tests/m9-label-handlers.test.ts
```

Exit code **0**: **10 files, 248 tests passed**.

The negative side is asserted in the same suites, not assumed:

- `m8-token-admin` — a revoked token stops working immediately; the scope ladder
  (`jobs:read` < `jobs:write` < `admin`) is enforced.
- `m8-jobs-repo` — "tenant isolation: org B cannot see, claim, cancel, write, or
  reference org A's job data"; the lease fence refuses a different worker.
- `m8-worker-reads` — a foreign trace and an unknown trace get the same `404`
  body; there is no existence oracle.
- `m8-ingest-traces` — two tenants ingest the same identity and get separate
  traces; another org's dataset is `unknown_dataset`.
- `m8-importer-scoping` — the file importer is org-scoped.

## 3. Size limits and failure modes

| Failure | Command | Result |
|---|---|---|
| Oversized body | `pnpm exec vitest run tests/m9-label-handlers.test.ts -t "rejects malformed, oversized"` | exit **0**, 2 passed; a 300,000-byte pad answers **413** and the set is untouched |
| Malformed result from a worker | `pnpm exec vitest run tests/m8-worker-api.test.ts -t "rejects an invalid result"` | exit **0**, 2 passed; **422** problem+json, the job keeps running, foreign artifact ids are refused |
| Worker killed mid-job | `pnpm exec vitest run tests/m8-jobs-repo.test.ts -t "reaped"` | exit **0**, 4 passed; an expired lease requeues while attempts remain, expires when exhausted, and the old worker can no longer write (`not_owner`) |
| Model server unreachable / slow / bad body | `python -m pytest examples/python-worker/test_backends.py examples/python-worker/test_agent_run.py -q -k "unreachable or timeout or 4xx or unusable_body or dead_model_server"` | exit **0**, 5 passed; the error is retryable and names the URL, a 4xx is not retryable, a 5xx is |
| Database down | `pnpm smoke` (variants A and B) | exit **0**, all 139 checks pass; pages serve and `/api/health` reports `degraded`, never a 5xx |

One limit is enforced in code but not exercised by a test: the **50 MB**
artifact cap in `src/shared/jobs/worker-handlers.ts` (a `413` "Artifact too
large"). It is listed here as untested rather than claimed.

## 4. A real trace round trip: import, store, export, deep-equal

```powershell
$env:SMOKE_DATABASE_URL="postgresql://traceforge:traceforge@localhost:15433/traceforge"
$env:PYTHONPATH=(Resolve-Path ..\VLM-DENTAL).Path
pnpm e2e:worker
```

Exit code **0**, "e2e: all checks passed" (47 `ok` checks). The relevant checks:

- `ingest/traces inserts the known image and rejects the unknown one (per-item, HTTP 200)`
- `the trace, its turns and its tool calls are really in Postgres (once, not doubled by the replay)`
- `the stored trace round-trips through GET /traces/{id} deep-equal`

The round trip ingests `fixtures/traces/verified_with_tools.json` over the real
worker contract into real Postgres, then reads it back through
`GET /api/worker/v1/traces/{id}` and compares the whole turn/tool-call payload
with the fixture using exact JSON equality: turn `idx`, tool `idx`, `toolName`,
`args`, `ok`, `error`, `artifactId`. A dropped argument, a reordered call or a
lost failure flag fails the check.

Negative controls already in the same run: the unknown image is rejected
per-item (`unknown_image`), and re-sending the same batch reports `existing`
with `sameContent: true` and the same `traceId`, so the read cannot pass by
accident on a second copy.

## 5. The live `agent.run` against LM Studio

```powershell
$env:SMOKE_DATABASE_URL="postgresql://traceforge:traceforge@localhost:15433/traceforge"
$env:E2E_DENTAL_AGENT_PATH=(Resolve-Path ..\VLM-DENTAL).Path
$env:E2E_LIVE_AGENT="1"
$env:E2E_LIVE_AGENT_MODEL="qwen3.5-4b"
$env:WORKER_OPENAI_BASE_URL="http://localhost:1234/v1"
$env:PYTHONPATH=$env:E2E_DENTAL_AGENT_PATH
pnpm e2e:worker
```

Exit code **0**, "e2e: all checks passed" (64 `ok` checks). The live path ran
**one** radiograph through `qwen3.5-4b` (the single image the heavy-run gate
allows without asking again):

- `the live worker registers a test model and advertises agent.run`
- `agent.run on the test backend succeeds`
- `…and names the trace it stored`
- `the stored trace carries backend/stage` (`openai_compat` / `test`)
- `…and at least one tool image is stored as an artifact`
- `…and Trace Explorer opens it with the stored tool image`

The live checks are opt-in. Without `E2E_LIVE_AGENT=1` the same command prints
`note live agent.run checks NOT run` instead of passing silently, and
`a worker that registers no model never advertises agent.run` proves the ladder
does not route an agent job to a worker that cannot serve it.

## 6. Degradation matrix

HTTP level, four deployment shapes:

```powershell
$env:SMOKE_DATABASE_URL="postgresql://traceforge:traceforge@localhost:15433/traceforge"
pnpm smoke
```

Exit code **0**, **139 checks passed** across:

- **A** database unreachable, `WORKER_MODE=off`
- **B** database unreachable, `WORKER_MODE=live`
- **C** database up, `WORKER_MODE=live`, no worker registered
- **D** insecure production config: must fail closed, and names the offending
  variables without echoing a secret value

Browser level, five shapes:

```powershell
$env:E2E_DATABASE_URL="postgresql://traceforge:traceforge@localhost:15433/traceforge_empty"
pnpm exec playwright test e2e/degradation.spec.ts --project=chromium
```

Exit code **0**, **120 passed (3.6m)**. Every page is checked for console
errors, failed same-origin requests, 5xx responses and an error boundary under
the five shapes (including failing storage). Nothing is filtered or retried.

## 7. The worker is outbound-only

Started the Python worker against an unreachable server with a fake token:

```powershell
$env:TRACEFORGE_URL="http://127.0.0.1:1"
$env:TRACEFORGE_TOKEN="tf_wrk_not-a-real-token"
$env:WORKER_NAME="proof-no-listen"
$p = Start-Process -FilePath "python" -ArgumentList "examples/python-worker/worker.py" -PassThru
Start-Sleep -Seconds 4
Get-NetTCPConnection -OwningProcess $p.Id -State Listen
```

The process was alive, **no LISTEN sockets**, and **0 sockets owned** at the
sample point (it was in register backoff). The app never calls a worker: workers
poll and the only sockets they ever open are outbound. The run also shows the
unreachable-server path is retried, not fatal.

## 8. Upstream drift: the probe degrades instead of crashing

VLM-DENTAL changes without notice, so this is the drill that proves the worker
survives a rename. `dental_agent` was copied to a temporary directory **outside
the repository**, `def run_agent(` in `dental_agent/agent/loop.py` was renamed
to `def run_agent_v2(`, and `vlm_compat.probe()` ran against the copy with
`GROUNDING_MODEL_PATH` pointed at the real weights.

The probe did not raise. It reported:

- `agent.run.torch_hf` **unavailable**: `dental_agent.agent.loop.run_agent not found`
- `tool.execute` **unavailable**: `dental_agent.agent.tool_dispatch: cannot import (ImportError: cannot import name 'run_agent' from 'dental_agent.agent.loop' ...)` — a realistic cascade: another module imported the renamed symbol
- `eval.run.torch_hf` **unavailable** for the same import
- `agent.run.openai_compat` and `eval.run.openai_compat` **still available**
- `capabilities.liveReplies` **false**
- `agent.run` still advertised, because the OpenAI-compatible backend still works

The real checkout was clean before and after (`git status --porcelain` empty),
and the temporary copy was deleted. The app side of the same rule is in
`tests/m8-capability.test.ts` (part of the 248 above): the ladder uses a live
worker only for the features it **declares**, ignores a stale worker (>120 s),
and falls through browser → replay → heuristic → unavailable in that order.

## 9. Editor timings (opt-in, same machine only)

```powershell
$env:E2E_DATABASE_URL="postgresql://traceforge:traceforge@localhost:15433/traceforge_e2e"
pnpm perf:editor
```

Exit code **0**, **2 passed (44.6 s)**, label `win11`. The spec boots the
production build (`next start`), signs in a fresh user, seeds 100 or 500 boxes
through the label API, and drives the real editor. Each number is milliseconds
from just before a dispatched input to the next painted frame, so it includes
the harness floor - an empty dispatch with no work at all measured p50 23 ms /
p95 24 ms on this machine. Raw JSON is written to `perf-results/` (git-ignored).

| Scenario (p50 / p95 ms) | 100 boxes | 500 boxes |
|---|---|---|
| drag a box, 80 moves | 39.2 / 41.7 | 38.7 / 48.8 |
| rubber-band draw, 60 moves | 39.8 / 52.2 | 38.5 / 70.1 |
| select another box, 20 clicks | 55.5 / 81.9 | 56.1 / 78.8 |
| keyboard edit, 20 keys | 40.3 / 55.8 | 38.6 / 56.3 |
| table `<select>`, 10 changes | 57.0 / 90.9 | 71.8 / 73.1 |
| long animation frames | 1 (171.8 ms, 78 ms blocking) | 1 (159.4 ms, 73 ms blocking) |
| DOM nodes on the page | 830 | 1229 |
| page load (saved status visible) | 0.87 s | 0.67 s |

Five times the boxes does not make the drag slower: above 40 boxes the table is
windowed (the spec asserts `aria-rowcount`) and the overlay only paints what is
on screen. What grows with the box count is the table path and the tail (p95),
which is why the numbers are recorded rather than asserted. Headless software
rendering on one Windows laptop - compare runs on the same machine, do not read
them as a frame-rate measurement.

The first version of this script was `E2E_PERF=1 playwright test ...`, which is
POSIX shell syntax and failed on Windows (`'E2E_PERF' is not recognized`). It is
now `scripts/perf-editor.mjs`, which sets the variable and spawns the Playwright
CLI, so the documented command works on every OS.

## 10. The deployed URL passes `smoke:prod`

```powershell
pnpm smoke:prod -- https://dentalforge-app.vercel.app
```

Exit code **0**, `smoke:prod: all checks passed` (69 checks, 2026-11-13) against
production deployment `dpl_D8g7ESPAUHFfj4ruzK84GukuaYUr` (commit `3eaed0e`, the
`main` of that day). That covers: every key page and API without a 5xx,
`/api/labels/status` 200 signed out, worker endpoints rejecting a missing token,
exactly one CSP header plus `X-Content-Type-Options: nosniff` and
`X-Frame-Options: DENY` on six pages, three demo images and three tool renders
loading as non-empty images, a strict console with zero CSP violations, and axe
with no WCAG A/AA violations on three pages.

Two earlier runs of the same command failed **25 checks** against an older
deployment (2026-11-13): `/about-data` and six `/demo-assets/*` files were 404
and no page sent the security headers. The cause was not the app: the Vercel
project was not linked to the GitHub repository, so `main` had never deployed.
The project is now linked (`productionBranch: main`), the two missing production
variables (`CRON_SECRET`, `DEMO_ORG_SLUG`) are set, and a push to `main`
deploys. Negative control for the cron: `POST /api/demo/reset` without the
secret and with a wrong secret both return **401**.

## 11. Browser YOLO: pre-labelling with no worker and no database

The editor's third rung is now real: `onnxruntime-web` in a Web Worker, fed by a
committed ONNX graph (ADR-0027, now `accepted`). Everything below was measured
on this machine; the full table with per-image rows is in the ADR.

```powershell
$env:DATABASE_URL="postgresql://traceforge:traceforge@localhost:15433/traceforge"
pnpm exec vitest run tests/m11-browser-yolo.test.ts
$env:E2E_DATABASE_URL="postgresql://traceforge:traceforge@localhost:15433/traceforge_e2e"
pnpm exec playwright test e2e/browser-yolo.spec.ts --project=chromium
```

- **Unit: 16 passed.** The TypeScript letterbox/decode/NMS reproduces the Python
  reference decoder on three held-out DENTEX validation images
  (`fixtures/yolo/val_{18,32,44}.json`, 177–221 candidate anchors each), with no
  ORT and no 50 MB download in CI.
- **Browser: 2 passed (32 s).** Real Chromium, `DATABASE_URL` pointing at a dead
  port and `WORKER_MODE=off`: the ladder offers the browser rung, the click
  produces 32 boxes on image 1 with `browser_approx` provenance, and a second run
  is served from Cache Storage (51,878,944 B, no second download). Console and
  CSP stay clean.

Measured numbers:

| Thing | Value |
|---|---|
| Shipped graph | `yolov8m-dentex-fp16-640.onnx`, **51,878,944 B (49.5 MiB)**, SHA-256 `f0fda350…f9e3350` |
| fp32 export (reference) | 103,697,245 B (98.9 MiB) |
| int8 dynamic (rejected) | 26,294,123 B (25.1 MiB) — min IoU 0.89–0.92, conf Δ 0.11–0.16, 25 s/image |
| Conversion parity, fp32 | min IoU **1.0000**, max conf Δ **2e-6** |
| Conversion parity, fp16 | min IoU **0.982–0.985** (mean 0.992), max conf Δ **0.0020** |
| End-to-end, Chromium | 32/32 boxes, min IoU **0.860**, mean 0.980, max conf Δ 0.034 |
| Inference in the browser | **4.7 s** (single-threaded WASM, 8-core laptop) — the 3 s target is missed |
| Worker bundle | 71.7 KiB, pre-bundled with esbuild; ORT runtime 11.9 MB copied from `node_modules` at build time |

The 4.7 s is the number a user waits after clicking; it is behind a progress
label and off the main thread, so the editor stays responsive. The residual IoU
loss end to end is image resampling (Skia vs PIL), not the export: fp32 and fp16
score the same in the browser (0.8613 vs 0.8603 min IoU). The browser tier
therefore claims "same boxes, `browser_approx`", never bit-identical output.

**Production (2026-11-14, `e4ee6b3`).** The deployed site serves the exact
committed graph: `GET /models/yolo/yolov8m-dentex-fp16-640.onnx` returned
51,878,944 bytes with SHA-256 `f0fda350…f9e3350` (downloaded and hashed, not just
a 200). Driving `/labels/1` in Chromium against the live URL produced 32 boxes in
**4.79 s** with `browser_approx` and zero `securitypolicyviolation` events, and
`pnpm smoke:prod` passed all 69 checks.

## Not run, and not claimed

- **SFT and GRPO training**: not run. `/training` shows both as "Not run yet";
  there are no training numbers in this repository.
- **`torch_hf` with a 9B checkpoint**: not run. It needs the owner's explicit
  approval under the heavy-run gate.
- **Browser YOLO mAP50 over a split**: not run. Conversion parity is measured per
  box; the drop in mAP50 for the fp16 graph over the validation split needs a
  whole-split run, which is behind the heavy-run gate, so it is not claimed.
- **YOLO over a whole split**: not run.
- **Phone check of the live site**: not run; it needs the owner.
- **The 50 MB artifact cap**: enforced in code, not exercised by a test.
- **Tufts**: never used in a public artifact, the demo bundle, the seed or this
  document. Public artifacts are DENTEX-derived only.
