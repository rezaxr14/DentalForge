# ADR-0024 — VLM-DENTAL compatibility layer: feature detection, versioned adapters, drift reports

Date: 2026-10-24 · Status: **implemented and tested** · Builds on ADR-0014 (tolerant model output, strict ground truth) and ADR-0013 (chunked ingest identity)

## Context
VLM-DENTAL is under continuous development and is **read-only input** for this repo. Pinning the worker to one of its commits would mean the worker silently serves stale behaviour after every upstream improvement, and a pin would also claim a guarantee this repo cannot test. The opposite failure is worse: importing upstream symbols directly and assuming their names, parameters and data shapes, so an upstream rename takes the worker down or, silently, makes it answer with the wrong tool semantics.

The app already has two sides that must not break:
- the **worker**, which runs upstream code on the owner's machine;
- the **importer**, which reads recorded trace/eval JSONL files whose shape upstream controls.

## Decisions

1. **Feature detection replaces pinning.** `examples/python-worker/vlm_compat.py` probes a checkout without loading a model, using a GPU or touching the network. It records, per capability profile (table 4.3 of the plan): the checkout path, `dental_agent` importability with the exact exception text, every required symbol imported and its signature checked (`inspect.signature`; a required parameter name that is absent marks that profile unavailable, extra parameters with defaults and `**kwargs` are tolerated), the tool names from `ToolRegistry.create_default()`, optional packages, CUDA, and the grounding weights file. A missing checkout is a report, not a crash; `probe_isolated()` additionally runs the probe in a child process so a broken native dependency (a torch build whose DLL cannot load, for example) cannot take the worker down.

2. **Presence is not importability.** `find_spec("transformers")` succeeds on an install whose own version check raises at import time — the exact state found on this machine (`transformers 5.14.1` with `huggingface-hub 2.2.0`). A job whose runtime package cannot be imported is **not** advertised, with a reason naming the package and the first line of the import error. Optional packages (`peft` for adapter checkpoints) only add a warning: a base-model run must not be disabled by a broken `peft`.

3. **The registry must be buildable.** `ToolRegistry.create_default()` imports the grounding module, which imports `ultralytics` at module scope. A torch-free install therefore cannot construct the registry, and every VLM job is unavailable there (reported as such). This is why `requirements-light.txt` alone cannot serve VLM jobs today; the honest answer is "no VLM jobs", not a half-working tool route.

4. **One contract job name per advertised capability.** The probe reports one row per backend (`agent.run.openai_compat`, `agent.run.torch_hf`) but `agent.run` is advertised once when either backend works. The app only ever sees the existing contract job names; upstream details never leak into the job contract.

5. **Provenance is recorded and never gates.** Commit, branch and dirty flag are sent in the worker registration `software` block together with the drift report (package versions, per-job availability/reason/warnings, tools, unknown/missing tools, grounding weights). The worker re-probes every `COMPAT_REPROBE_S` (default 300 s) and re-registers when the report changes, so a `git pull` in VLM-DENTAL is visible without a restart. Handlers are wired at start-up, so a *newly available job type* still needs a restart; the report is what the app displays meanwhile. Provenance is stored on traces the worker creates (`meta.vlmDental`) and in the demo manifest; it is never compared to decide behaviour.

6. **Adapters are versioned and tolerant.** `src/shared/vlm/adapters/` owns the readers for upstream data shapes. `trace.v1` and `eval.v1` keep unknown fields (`extra` on traces, counted dotted paths in diagnostics), default missing optional fields, count a line they cannot read and report why instead of throwing, and stamp `adapterVersion` on every row. `src/shared/lib/import/parse.ts` is now a re-export shim: the M7 importer and its tests were not changed. The adapter version is stored in new nullable `traces.adapter_version` / `eval_runs.adapter_version` columns (migration `0006_lively_guardian.sql`); NULL means "imported before this layer existed", which is the truthful value.
   When upstream changes a shape the fix is a **new adapter version**, not an edit to core code or to an old reader.

7. **Drift is a report, not a red required check.** Three layers:
   - `examples/python-worker/test_vlm_compat.py`: fake `dental_agent` packages prove the probe reacts to shape (renamed parameter, unknown tool, broken registry, crashing probe) rather than to this machine's install;
   - `tests/python/test_compat_contract.py`: runs against a real checkout, skips with a visible reason when absent (`CI_REQUIRE_VLM=1` makes absence a failure), checks every row of table 4.3, that every unavailable reason is a precise known form, that the probe does not modify the checkout, and compares tool outputs to `fixtures/goldens/vlm_tools.json`;
   - `.github/workflows/upstream-compat.yml`: weekly and manual, clones public upstream `main`, installs the light set, runs the contract tests, uploads the report, and opens or updates **one** issue titled "Upstream drift". It is deliberately not a required check.

8. **Tool goldens are environment-aware.** The golden records the three tracked DENTEX sample images (size + file sha256), all eight tools with fixed arguments (images by size + raw-pixel sha256, data by rounded values) and a package fingerprint. Model tools (`locate_tooth`, YOLO) are compared only when the fingerprint matches the recorded one — a different torch/ultralytics build moved a box by 4 px on this machine with no upstream change. Deterministic tools are compared everywhere. `tools_goldens.py --write` refuses to write a partial golden when grounding is unavailable; regeneration is an owner decision.

9. **The checkout is never modified.** The probe sets `sys.dont_write_bytecode = True` before importing upstream modules (otherwise Python writes `__pycache__` into the read-only tree), and the contract test asserts `git status --porcelain` is unchanged by a probe.

## Not done / consequences
- SFT and GRPO have **not been run**. Nothing in this layer reports training results.
- `agent.run`, `eval.run`, `al.score` and `trace.render_artifacts` handlers are still stubs in `worker.py`; this ADR covers the compatibility layer and adapters only (WP2/WP3 wire the handlers).
- No CSV eval adapter yet. The existing importer read JSONL only, and this refactor was required to preserve behaviour; a `eval.csv.v1` reader can be added without touching `eval.v1`.
- `requirements-light.txt` cannot serve VLM jobs because the upstream registry imports `ultralytics`; the file's comment says so. The weekly job therefore verifies signatures and tool names and skips tool execution when the runtime is absent.
- The probe's package import check runs in-process for the CLI and for the contract test (the CLI is already a dedicated process); the worker uses the isolated form.
- A probe run before this ADR wrote `__pycache__` files into the checkout (ignored by git, tracked status clean). Bytecode writing is now disabled.

## Evidence
All commands below were run on this Windows machine, in the working venv (`C:\Users\rezax\Home\Code\vlm-dental\.venv`), against VLM-DENTAL HEAD `1346424` (branch `main`, clean) unless a different interpreter is named. Exit codes were read directly (`$LASTEXITCODE`), not inferred from a pipe.

- Python worker suites, one run: `python -m pytest -q examples/python-worker/test_dental_handlers.py test_vlm_compat.py test_worker_software.py test_tools_goldens.py` → exit 0, **56 passed** in 17.36 s (26 handler + 17 probe + 6 software + 7 goldens).
- `pnpm compat` → exit 0. All eight tools present (`zoom_crop, window_level, locate_tooth, fdi_label, denoise, contralateral_compare, enhance_contrast, nudge_crop`); available `tool.execute, trace.render_artifacts, yolo.prelabel, al.score, agent.run.openai_compat`; `agent.run.torch_hf` and `eval.run` skipped with the venv's real error (`ImportError: huggingface-hub>=1.5.0,<2.0 is required ... found huggingface-hub==2.2.0`); advertised contract jobs `tool.execute, trace.render_artifacts, yolo.prelabel, al.score, agent.run`.
- `python -m pytest -q tests/python/test_compat_contract.py` (working venv, `VLM_DENTAL_PATH` set) → exit 0, **7 passed** in 27.21 s. Same file with the system interpreter (torch 2.11.0+cu128, transformers 5.16.1, ultralytics 8.3.233) → exit 0, **6 passed, 1 skipped**, skip reason printed: `model tool numbers are only comparable on the golden's stack; changed: numpy 2.5.1 -> 2.2.6; torch 2.5.1+cu121 -> 2.11.0+cu128; transformers 5.14.1 -> 5.16.1; ultralytics 8.4.116 -> 8.3.233`. The system interpreter also crashed the *child* probe process (Windows fatal exception `0xc0000139` importing `torchvision` through `peft`); the suite still passed, which is `probe_isolated()` doing its job.
- `python tools_goldens.py --check` (working venv) → exit 0, `[goldens] match (3 images x 8 tools)`.
- `pnpm typecheck` → exit 0. `pnpm lint` → exit 0 with one pre-existing warning in `scripts/e2e-worker.mjs` (untouched by this change).
- `pnpm test` → exit 1 overall: **490 passed, 201 skipped** (691), 1 of 35 files failing. The failure is `tests/m8-bus-redis.test.ts` in `afterAll` only (`EBUSY: resource busy or locked, rmdir ...\tf-redis-...`), a Windows file-lock artefact of the Redis suite's temp config dir; its 11 tests ran (5 skipped by design). This suite and the Redis bus were not modified by this work, and CI runs Linux.
- `pnpm vitest run tests/m10-adapters.test.ts tests/m7-importer.test.ts tests/m8-eval-real-data.test.ts tests/m8-worker-api.test.ts` → exit 0, **61 passed, 17 skipped** (78) across 4 files. The M7 importer tests were not modified and still pass through the `parse.ts` shim.
- Acceptance controls of section 4.5, all against temp copies of a fake `dental_agent`: (a) a renamed required parameter and a missing symbol mark exactly the affected job unavailable with a precise reason while the others stay available (`test_a_renamed_required_parameter_is_a_precise_reason_not_a_crash`, `test_missing_agent_symbols_mark_only_the_agent_jobs_unavailable`); (b) an unknown tool is flagged `unknownToApp` without breaking the report (`test_tool_jobs_are_advertised_and_unknown_tools_are_flagged_but_not_fatal`); (c) with no `dental_agent` at all every VLM job is unavailable, no exception is raised and the worker still registers (`test_no_checkout_reports_every_job_unavailable_without_raising`, `test_software_survives_a_missing_checkout`, `test_register_without_software_still_sends_python`); (d) a trace line with extra fields, missing optional fields and one unreadable line imports with exact counts (`tests/m10-adapters.test.ts`, and `scripts/diagnose-real-data.ts` prints read/skipped/unknown/variants).
- Mutation testing (harness kept outside the repo, per the plan: copy the unit, replace one exact string that must occur once, run the relevant tests, exit ≠ 0 = killed, restore and compare by hash): **7/7 killed**. Probe mutants: drop the `**kwargs` tolerance, ignore a missing required parameter, treat presence as importability, gate availability on the git commit. Adapter mutants: drop `extra`, stop counting skipped lines, hard-code the eval summary. `trace.ts` was restored and verified by sha256.

Not verified here:
- The weekly `upstream-compat.yml` has not run yet (no CI execution at the time of writing); only the same commands it calls were run locally.
- No model was loaded and no training was run. SFT/GRPO results do not exist.
- The app-side rendering of "worker online, no VLM jobs" is WP4/WP10; this ADR only proves the worker registers with zero VLM jobs.
- The stored goldens were generated in the working venv (torch 2.5.1+cu121, ultralytics 8.4.116); model-tool numbers are only meaningful on that stack.
