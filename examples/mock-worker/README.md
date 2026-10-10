# Mock worker

A TypeScript worker that speaks the **real** contract (`docs/worker-contract.md`)
and answers deterministically from `fixtures/` (real YOLO predictions, a real
verified trace, real eval cases). Image tools return a labeled **placeholder** PNG —
it proves the pipe, not the pixels.

```bash
pnpm worker:token --org <slug> --name mock      # prints a tf_wrk_… token once
TRACEFORGE_URL=http://localhost:3000 TRACEFORGE_TOKEN=tf_wrk_… pnpm mock-worker
```

Env: `MOCK_WORKER_NAME`, `MOCK_STEP_DELAY_MS` (default 300), `MOCK_MAX_JOBS`,
`MOCK_CLAIM_WAIT_MS` (default 10000). Handles `system.ping`, `yolo.prelabel`
(images 1–5), `tool.execute`, `agent.run`, `eval.run`, `al.score`. It does **not**
claim `trace.render_artifacts`, so the app never routes that to it.
