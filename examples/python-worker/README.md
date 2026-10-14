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
- `yolo.prelabel`: advertised only when `ultralytics` and the grounding weights are loaded.
- Still stubs (not advertised): `agent.run`, `eval.run`, `al.score`, `trace.render_artifacts`, `parity.golden`.

Tests: `pytest test_dental_handlers.py` (fakes; runs anywhere, in CI) and
`PYTHONPATH=/path/to/VLM-DENTAL pytest test_real_dental_agent.py` (real tools; not in CI).
Pipeline check with the real tools: `E2E_DENTAL_AGENT_PATH=/path/to/VLM-DENTAL pnpm e2e:worker`.
