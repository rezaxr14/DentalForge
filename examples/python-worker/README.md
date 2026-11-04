# Python reference worker

Outbound-only, so it runs anywhere that can reach the app over HTTPS.

```bash
pip install -r requirements.txt
export TRACEFORGE_URL=https://your-app.vercel.app
export TRACEFORGE_TOKEN=tf_wrk_…          # pnpm worker:token --org <slug>
python worker.py
```

Env: `WORKER_NAME`, `WORKER_RUNTIME` (`local-gpu` | `colab` | `kaggle` | `cloud`),
`MAX_JOBS`, `STEP_DELAY_S`.

**Local GPU box:** run it in a terminal or as a service.
**Colab / Kaggle:** `!pip install httpx` then run `worker.py` in a background cell
(`!python worker.py &` or `subprocess.Popen`). Sessions die; that is fine — the
app requeues the job when the lease lapses and the next session re-registers under
the same `WORKER_NAME`, keeping its worker id.

Only handlers in `HANDLERS` are advertised, so the app's capability ladder never
sends this worker work it cannot do. Moving a stub into `HANDLERS` is how you
"connect the PyTorch backend".

## Real handlers (VLM-DENTAL)

`system.ping` always. `tool.execute` and `yolo.prelabel` are added by `dental_handlers.py`
when the research package is importable (ADR-0016):

```bash
pip install -r requirements.txt pillow
export PYTHONPATH=/path/to/VLM-DENTAL        # or: pip install -e /path/to/VLM-DENTAL
export YOLO_MODEL_ID=<registered model id>   # optional: refuse jobs for any other model
python worker.py                             # the startup log lists what is advertised and why not
```

- `tool.execute`: the 8 agent tools (`zoom_crop`, `window_level`, `enhance_contrast`, `denoise`,
  `contralateral_compare`, `nudge_crop`, `fdi_label`, `locate_tooth`). `locate_tooth` needs the YOLO
  grounding weights; without them that tool fails the job instead of returning a made-up box.
- `trace.render_artifacts`: re-runs the tool calls of a stored trace and uploads the images
  (`render_artifacts.py`). Same prerequisites as `tool.execute`; dedupes identical PNGs by sha256.
- `yolo.prelabel`, `al.score`: advertised only when `ultralytics` and the grounding weights are loaded.
  `al.score`'s entropy is the normalized Shannon entropy over retained box confidences (ADR-0025).
- `agent.run` (`agent_run.py`): advertised once a model is registered from `WORKER_MODELS_FILE`.
- `eval.run` (`eval_run.py`): same per-image path as `agent.run`; per-case metrics come from
  VLM-DENTAL's `match_multi_findings`, never from a second implementation. Chunks cases at 100 and
  posts them to `/ingest/eval-run`, which upserts on `(run, image_id)`.
- `parity.golden` is **not** a job type: it ships as the dev CLI `tools_goldens.py` (ADR-0025 §5).

Tests: `pytest test_dental_handlers.py` (fakes; runs anywhere, in CI) and
`PYTHONPATH=/path/to/VLM-DENTAL pytest test_real_dental_agent.py` (real tools; not in CI).
Pipeline check with the real tools: `E2E_DENTAL_AGENT_PATH=/path/to/VLM-DENTAL pnpm e2e:worker`.

The wire shapes the three WP3 handlers produce are recorded once
(`record_acceptance.py --write`) into `fixtures/worker/wp3-acceptance.json` and validated by both
`tests/python/test_wp3_acceptance.py` (against `docs/worker-openapi.json`) and
`tests/m8-wp3-acceptance.test.ts` (against the Zod contracts). `--check` fails if a handler drifts.
