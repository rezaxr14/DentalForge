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
sends this worker work it cannot do. Today only `system.ping` is implemented; the
rest are stubs whose docstrings name the VLM-DENTAL function to call. Moving a stub
into `HANDLERS` is how you "connect the PyTorch backend".
