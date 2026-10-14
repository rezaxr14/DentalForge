# ADR-0016 — M8 task G: real `tool.execute` and `yolo.prelabel` handlers in the reference worker

Date: 2026-10-14 · Status: accepted

## Context
The Python reference worker implemented only `system.ping`; every other job type was a stub. Task G connects the research code (VLM-DENTAL's `dental_agent`) so the capability
ladder's "worker" tier does real work. `agent.run` (needs the 9B model on a GPU and a per-turn callback in `run_agent`), `eval.run`, `al.score`, `trace.render_artifacts` and
`parity.golden` stay stubs and are NOT advertised.

## Decisions
1. **Advertise only what can run.** `dental_handlers.discover()` returns a handler only when its prerequisites hold and prints why it skipped the others. `tool.execute` needs
   `dental_agent` importable; `yolo.prelabel` needs `ultralytics` and the grounding weights loaded. Contract advertising is per job type, not per tool, so without weights
   `tool.execute` is still advertised and `locate_tooth` alone fails the job (non-retryable, "needs the YOLO grounding weights") instead of returning an invented box. The startup
   log says so.
2. **One dispatch convention.** `tool.execute` calls VLM-DENTAL's shared `execute_tool_call` (which tools receive the source image), the function SFT and GRPO use, so the worker
   cannot drift from the training-time calling convention. Tools always run on the NATIVE image; `view: "canonical"` only resamples the rendered output to the family canvas
   (`to_canonical`), as SFT does.
3. **Tool answers are results, not failures.** Image outputs are uploaded as PNG artifacts; dict/str/None outputs (including `{"error": "Tooth 38 not found"}`) are returned as
   `kind: "data"`, because the agent must see them. A tool that raises (bad arguments) fails the job as non-retryable: identical arguments fail identically.
4. **`yolo.prelabel` calls the model directly.** `locate_tooth` returns one padded box for one tooth; pre-labelling needs every raw detection. `classIdx = (quadrant-1)*8 +
   (position-1)`; boxes are clipped to the image (cut, never shifted), sorted by confidence. A class index outside 0-31 fails the job rather than being dropped (never skip silently).
   `YOLO_MODEL_ID`, if set, makes the worker refuse a job for any other `modelId` instead of labelling the wrong model's output; if unset it answers any id and echoes it.
5. **Pixels are verified.** Images are fetched through `GET /images/{id}` and the signed URL (no bearer header). If the decoded size differs from the stored width/height the job
   fails (non-retryable): every coordinate would be in the wrong space. Integer image ids (allowed by the payload schema, unresolvable by the endpoint) fail non-retryable too.
6. **Shared exception types live in `worker_errors.py`.** `python worker.py` runs as `__main__`; a handler module importing `worker` would load a second copy whose `NonRetryable`
   is a different class, and `run_job` would report non-retryable failures as retryable. A unit test pins class identity.

## Evidence
26 unit tests with injected fakes (CI), 25 mutations killed; 10 integration tests against the real tools (`PYTHONPATH=VLM-DENTAL`, not CI); `pnpm e2e:worker` with
`E2E_DENTAL_AGENT_PATH` drives real `zoom_crop`, canonical `window_level` (1536x768), `fdi_label` and the `locate_tooth` failure through the real server, which validates every result
against the contract (mutating the wire format or the canonical resampling fails it). **Not verified:** `yolo.prelabel` against real YOLO weights and `locate_tooth` with weights
(no GPU/weights here); Windows.

## Consequences
`agent.run` still needs a VLM-DENTAL change: `run_agent` takes a DataFrame of local paths and has no per-turn callback, so streaming `turn` events needs one.
