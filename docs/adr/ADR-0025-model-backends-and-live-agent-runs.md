# ADR-0025 — Model backends and live `agent.run`: the test-stage firewall, provenance, and what a live trace can prove

Date: 2026-10-24 · Status: **implemented and tested** · Builds on ADR-0024 (compatibility layer), ADR-0014 (tolerant model output), ADR-0008 (fixture fallback)

## Context

WP2 gives the worker two ways to answer an `agent.run` job:

- **`torch_hf`** — the real backend: VLM-DENTAL's own Qwen backbone through its own `run_agent` loop, optionally with a LoRA adapter or a merged checkpoint. This is the model the research was done with.
- **`openai_compat`** — a local OpenAI-compatible server (LM Studio by default). It exists so the whole pipeline — job, streamed turns, stored trace, Trace Explorer, artifacts — can be exercised on a laptop **before** a trained adapter exists, and by anyone reviewing the app without a GPU.

That second backend creates a hazard the app did not have before: numbers produced by a 4B model on a laptop are not research results, and they must never be able to look like them. Three smaller forces pull in the same direction:

1. The app's reads are deliberately forgiving (ADR-0008: fixtures when the DB is unreachable). A forgiving read path can silently prove the *wrong* thing in an end-to-end test.
2. A live run has provenance a file import does not (which backend, which stage), and the app must record it without ever making behaviour depend on it.
3. A live run needs a trace the app can store: dataset identity and ground truth for the image, which the file importer never had to ask for.

## Decisions

### 1. Two backends, one contract, advertised honestly

`agent.run` is advertised per backend that actually started. `torch_hf` loads lazily on the first job (the 9B model is never loaded at worker start-up), keeps the model resident, serializes GPU jobs with one re-entrant lock, and unloads after `WORKER_MODEL_IDLE_UNLOAD_S` (default 600 s, 0 disables). `openai_compat` needs only an HTTP base URL. A model file naming a backend the worker did not start makes that `modelId` a `NonRetryable` failure with the reason, not a crash and not a silent fallback to the other backend.

`TorchHFBackend` takes injectable `loader` / `checkpoint_loader` / `runner` / `no_tools_runner` / `images_df_factory` / `registry_factory`. The injectable registry was added because the loop tests need upstream, while the torch tests do not: CI installs only `pytest` + `pillow`, so torch behaviour is proven with fakes and the loop tests skip **visibly** (`skipif` on `importlib.util.find_spec("dental_agent")`). A skip that says why is honest; a test that fails for a missing optional package is noise.

### 2. Stage vocabulary: `base` is the registry's `zero_shot`, and `test` is new

The worker's model file uses the research vocabulary `base | sft | grpo | test`. The app's model registry already had `zero_shot | sft | grpo | yolo`, so:

- a `base` entry **registers as `zero_shot`** (one row, one meaning; the mapping lives in `backends/base.py::APP_STAGE` and is unit-tested);
- `test` was **added** to `ModelStage` / `ModelRecord.stage` / the schema enum. It is a real stage, not a hidden flag, so "which rows are test rows?" is one column read, not a convention.

The worker registers every entry of `WORKER_MODELS_FILE` on **every start** (re-register updates the same row), keeps `{app modelId → ModelSpec}` in memory, and rebuilds it on restart. The app's `modelId` is a UUID, the owner's file uses stable names; the mapping is deliberately not persisted anywhere the worker would have to trust.

`traces.stage` and `eval_runs.stage` use the **worker's** vocabulary (`base`), not the registry's (`zero_shot`): they describe the run, not the registry row. `RunStage` / `RunBackend` live in `contracts/ingest.ts` and both are optional.

### 3. Test-stage rows are excluded by a filter that keeps imported rows

`listTraces({ researchOnly: true })` and the eval leaderboard filter with:

```sql
traces.stage IS DISTINCT FROM 'test'
```

not `<> 'test'`. Every trace imported from a file has `stage = NULL` (unknown, and honest about it), and `NULL <> 'test'` is `NULL`, which would drop **all** imported DENTEX traces from every research view. `IS DISTINCT FROM` keeps them. The in-memory store implements the same predicate, so the two stores agree. Trace Explorer itself passes no filter and shows a "Test backend (not the research model)" badge on the detail page, so a reviewer can see the run without it entering a cohort.

`backend` / `stage` are **nullable** on `traces` and `eval_runs`; `NULL` means "imported before this layer existed". Nothing gates on them; they are provenance (the rule from ADR-0024: record, never pin).

### 4. The `openai_compat` loop is a copy, and the copy is tested

SFT and GRPO were trained on the exact message protocol in `dental_agent/agent/loop.py`, so `backends/openai_compat.py::run_loop` is a deliberate line-for-line copy of the message construction, observation text, budget message, malformed-reply handling and tool dispatch — not a paraphrase. Two consequences:

- **The system prompt comes from upstream.** `build_agent_system_prompt(registry.format_tool_descriptions(), dataset=…)` is called, not re-typed. `tests/python/test_protocol_conformance.py` asserts our prompt equals upstream's, and that the recorded prompt lists the same tools. It does **not** compare our prompt to the prompt stored in old traces: those traces predate the current upstream prompt (it gained a healthy-scan paragraph), so that comparison would be a drift report about the corpus, not about the loop.
- **Replay is the drift check.** A recorded with-tools DENTEX trace is replayed: assistant replies go through a `ScriptedBackend`, tool outcomes through a `ReplayRegistry` (per-tool FIFO of the recorded image/result/error), and the messages we build are compared to the recorded ones. Assistant messages are byte-identical; observation messages are identical after mapping "the exporter replaced this image with a placeholder" to "we put the image part there" (the pixels are not in the trace).

Not every recorded trace is replayable *by the policy loop at all*: `rejected_final_answer`, `invalid_tool_format` and bare-string user messages were produced by other paths. A documented predicate excludes them; **45 of 50 sampled DENTEX traces** satisfy it. Excluding them is stated in the test, not hidden in a count.

**Bug the live run found:** the loop calls `complete(messages, temperature=…, seed=…)` and does not know the served model name, but the backend's `complete` requires `model`. Every live run died on a missing keyword argument until `OpenAICompatBackend.completer(model)` bound the name; the handler now passes the bound completer. A regression test drives the handler's com path and asserts the server body carries `basePath`, `temperature` and `seed`.

### 5. `torch_hf` delivers turns at completion, and uploads no tool images

Upstream has no per-turn hook, so the backend emits every `turn` event after `run_agent` returns. That is a visible consequence, not a hidden one: the UI says turns arrive at completion for this backend. The optional progress tap the plan allows (wrapping `generate_agent_reply`) was **not** installed — monkey-patching upstream in-process is a correctness risk for a file we are told never to modify, and the plan makes it optional.

Tool images from a `torch_hf` run are **not** uploaded: the trajectory does not hand them out. `trace.render_artifacts` (WP3) re-executes the calls and uploads the results. `openai_compat` can upload, because our loop owns the sink.

### 6. A live run's image metadata and ground truth

`GET /images/{id}` now returns `imageId`, `sourceImageId`, `datasetId`, `dataset`, `datasetName`, `split`, and `groundTruth` (strict `Finding[]`) in addition to the URL and size. The ground truth is taken from an **already-imported trace** for that image (verified first); `null` means the app does not know it.

The worker's policy is deliberately asymmetric:

- **unknown ground truth** → skip ingestion and log it. The run still succeeds and its turns are still streamed; inventing `[]` would turn "unknown" into "healthy scan" and poison a dataset;
- **an ingest that comes back rejected or errored** → `NonRetryable`. Losing provenance silently is worse than failing a job whose results the operator can re-run.

`finalAnswer` and `turns[].parsed.final_answer` were relaxed from `Finding` to `PredictedFinding` (ADR-0014's tolerant class) for the same reason the eval importer was: a model output that is *wrong* must still be representable, or the trace cannot be stored at all. Ground truth stays strict. An unnamed tool call is stored with `tool_name: ""` so the required string field accepts it while `tool_error` is kept.

### 7. `artifact_id` is the link from a tool call to its pixels

A tool that returns an image gives the sink PNG bytes; the sink uploads through the existing signed gateway and returns the artifact id; the loop records it on the call record; the adapter and the DB keep it; the trace page looks it up and renders the stored image (the §9 ladder: stored artifact → placeholder with args). `openai_compat` passes a real sink. Uploaded artifacts under `agent.run` are kind `agent_image` — the read path accepts `tool_image` **or** `agent_image`, so a live trace renders like an imported one.

### 8. `temperature` is part of the payload

`AgentRunPayload.temperature` (0–2, default 0) is forwarded per turn; `seed` seeds torch when the backend is `torch_hf`. Greedy stays the default because that is how evaluation is defined.

### 9. Capability-aware tests, and a read path that must be proven

Two tests had encoded one machine's state as truth:

- `test_locate_tooth…` assumed "no grounding weights here" and failed on the GPU box. It now asks which branch is true: without weights the tool must refuse (never invent a box), with them it must actually run.
- The e2e's real-tool block did the same; it is now capability-aware in the same way.

The live e2e also runs `val_18` — the plan's acceptance image — rather than a synthetic mosaic, because a small model correctly saw nothing to zoom into on noise and answered in one turn with zero tool calls, which proves nothing about artifacts. `E2E_LIVE_AGENT_IMAGE` overrides it; if no real radiograph is available the run falls back to the mosaic and **prints a note** instead of asserting a tool call happened.

**Bug the live run found (read path):** the e2e server was started without `TRACEFORGE_DATASOURCE=postgres` and without `IMPORT_ORG_SLUG=<this run's org>`, so every page read the committed fixtures. The trace *write* checks passed — rows were in Postgres — while the trace page said "Trace not found" for the trace the run had just stored. Two environment variables, both read only by the read path, were the whole difference between "proven" and "looked proven". Production sets both; the e2e now mirrors production.

## Not done / consequences

- **The 9B `torch_hf` smoke was not run.** The heavy-run gate requires the owner's explicit yes. The backend is covered by injected fakes only.
- **SFT and GRPO were not trained and not run.** No adapter directory exists, so no `sft` / `grpo` registry row exists. No metric anywhere in this repo comes from them; where the UI needs a number it says "no run yet".
- The working venv's `transformers` is **unusable** (`huggingface-hub 2.2.0` vs the required `<2.0`), so `pnpm compat` reports `agent.run.torch_hf` and `eval.run` as `SKIP` with that exact reason on this machine. That is the probe doing its job, not a passing torch path.
- `torch_hf` has no per-turn streaming until upstream offers a hook.
- `rewardComponents` is omitted everywhere; a torch-free implementation does not exist.
- The live e2e needs LM Studio, a loaded model and a VLM-DENTAL checkout. It is **not** in CI (CI has none of those); the deterministic suite is what CI gates on.

## Evidence

Run on 2026-10-24, Windows 11, Node/pnpm as in the repo, Postgres 17 in Docker (`traceforge-db`, port 5433), LM Studio at `http://localhost:1234/v1`.

- `pnpm typecheck` → exit 0.
- `pnpm lint` → exit 0, **0 errors, 0 warnings** (the one long-standing warning in `scripts/e2e-worker.mjs` — a helper parameter that was never used — is fixed in this change).
- `pnpm exec vitest run --reporter=dot` → **700 passed, 0 failed** across 35 files; exit 1 overall because `tests/m8-bus-redis.test.ts` throws `EBUSY … rmdir …\tf-redis-…` in `afterAll` on Windows. Pre-existing, untouched by this work, and CI runs Linux.
- Python worker suite in the working venv (`C:\Users\rezax\Home\Code\vlm-dental\.venv`, torch 2.5.1+cu121, ultralytics 8.4.116) → **125 passed**, exit 0.
- The CI-shaped subset under the **system** Python 3.12.3, which has no `dental_agent` → **116 passed, 10 skipped**, exit 0. The 10 skips are the loop/conformance tests, printed with their reason.
- `pnpm compat` → exit 0; `tool.execute`, `trace.render_artifacts`, `yolo.prelabel`, `al.score`, `agent.run.openai_compat` OK; `agent.run.torch_hf` and `eval.run` SKIP for the `transformers`/`huggingface-hub` reason above.
- `pnpm build` with the CI production secrets → exit 0.
- **Live acceptance (plan WP2 acceptance 1), `pnpm e2e:worker` with `E2E_LIVE_AGENT=1`** → exit 0, **all checks passed**: a real `val_18` radiograph (3003×1316) seeded as the run's image, the worker registered a `test` model and advertised `agent.run`, the job succeeded on `qwen3.5-4b` through LM Studio, the stored trace carries `backend=openai_compat` / `stage=test`, at least one tool image was stored as an artifact, and `GET /traces/{id}` rendered it (`stored artifact` + `Test backend`).
- **Screenshots viewed** (Playwright against the production build, a seeded org deleted afterwards): the trace page at 1280 px light, 1280 px dark and 390 px mobile showed the amber "Test backend (openai_compat) — not the research model" banner, the stored tool image with `stored artifact` + its `worker_exact` provenance, and the responsive stacking. No layout regression from the banner.
- Scripted-backend suite (`examples/python-worker/test_backends.py`, `test_agent_run.py`) covers the failure modes: server unreachable (retryable, with the reason), malformed JSON (retry then `formatOk=false`, last reply preserved), unknown tool (an observation, not a crash), tool exception (recorded as `loop.py` does), budget exhaustion (the model is told and can answer), cancellation between turns, and timeout.
- `torch_hf` with injected fakes: trajectory→events, cohort switch (`run_agent` vs `run_agent_no_tools`), adapter/checkpoint path selection, laziness, serialization, idle unload, model switch releases the previous model.
- Protocol conformance: `tests/python/test_protocol_conformance.py` and the loop's own tests pass in the venv (system Python skips them visibly).
- Mutation testing (harness kept outside the repo: replace one exact string that must occur a known number of times, run the tests that should catch it, non-zero exit = killed, restore, verify by sha256): **17/17 killed** — `base`→`zero_shot` mapping, single-object final answer, artifact id on the call, temperature forwarding, unknown-GT skip, rejected-ingest hard-fail, `hybrid` cohort label, unnamed tool call, idle unload, `IS DISTINCT FROM` research filter, artifact id persistence, eval-run backend, trace backend/stage passthrough, image ground truth, datasource read path, adapter `artifact_id`, in-memory research filter. Every file was restored byte-exactly.
- `git -C ../vlm-dental status --porcelain` → empty; `git -C ../vlm-dental diff --stat` → empty; HEAD `1346424dfb4ab85f8522070a82fbc59e1dd89b33`. Upstream was read-only throughout.

Not verified here:
- The 9B `torch_hf` path end to end, training, and every SFT/GRPO claim (none are made).
- The weekly `upstream-compat.yml` run (it now also runs the conformance test); only its commands were run locally.
- The `E2E_REDIS_URL` (bus-enabled) variant of the e2e.
- Behaviour on a machine without the grounding weights: the capability-aware tests take the other branch, so the *guard* is proven, and the run branch was exercised on this machine.
