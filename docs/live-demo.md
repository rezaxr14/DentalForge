# Live Demo Runbook

This document describes how to run a live demo session with a worker attached.
The live mode is only attached during arranged demos; otherwise the app shows
recorded runs. **No promise of availability.**

## Prerequisites

- VLM-DENTAL cloned at `../vlm-dental` (or set `VLM_DENTAL_PATH`)
- LM Studio running with a compatible model loaded (test backend)
  - Qwen 3.5 4B 4-bit GGUF (or similar) loaded in LM Studio
  - LM Studio server started on `http://localhost:1234`
- Python venv with: `torch`, `transformers`, `peft`, `ultralytics`, `onnxruntime`
- Supabase project with the demo database
- `.env.worker` file (never committed) with:
  ```
  DATABASE_URL=postgresql://... (Supabase pooled)
  BETTER_AUTH_URL=https://dentalforge-app.vercel.app
  BETTER_AUTH_SECRET=...
  INVITE_SIGNING_SECRET=...
  WORKER_MODE=live
  VLM_DENTAL_PATH=../vlm-dental
  LM_STUDIO_URL=http://host.docker.internal:1234/v1  # or localhost:1234
  WORKER_TOKEN=...  # from admin UI
  ```

## Pre-flight checklist

1. **App is deployed and healthy**
   - https://dentalforge-app.vercel.app/api/health → `{"status":"ok","db":"up",...}`
   - `/status` page shows all green (DB, worker off, Redis absent, storage local)
   - The public URL deploys from `main` automatically; before a demo run
     `pnpm smoke:prod -- <url>` and demo from a local production build if it
     does not pass.

2. **LM Studio is reachable**
   - `curl http://localhost:1234/v1/models` returns the loaded model
   - Model accepts images (vision-capable)

3. **Worker token exists with correct scopes**
   - Go to `/settings/workers` (signed in as admin)
   - Create token: name `live-demo-<date>`, scopes: `claim`, `events`, `artifacts`, `ingest`
   - Copy the token **once** (shown only on creation) → paste into `.env.worker`

4. **Demo data is seeded**
   - `pnpm demo:build && pnpm demo:seed --reset` (against the same DB)

## Starting the worker

```powershell
# From the DentalForge repo root
.\scripts\start-worker.ps1
```

The script will:
1. Load `.env.worker`
2. Run the VLM-DENTAL compatibility probe (prints capability report)
3. Start the worker process

## What you'll see

- **Terminal:** Worker logs including heartbeat registration, job claims, events
- **App `/status` page:** Badge changes from "Worker offline" → "Worker online: <model> (test backend)" within 5-10 seconds
- **`/agent` page:** Live run panel enables "Queue run" button; form accepts DENTEX case ID or image UUID

## Running a live job

1. Open `/agent` in the browser
2. Pick a trace from the picker (or use the default rich trace)
3. Fill the live run form:
   - DENTEX case ID: `255` (or any case with a public image)
   - Model ID: `lm-studio-test` (or the model name from LM Studio)
   - Max turns: `10`
   - With tools: checked
4. Click "Queue run"
5. Watch the replay — new turns appear as the worker streams events
6. Tool renders appear in the turn timeline; final predictions overlay on the radiograph

## Stopping the worker

- Press `Ctrl+C` in the worker terminal
- Jobs in flight will fail cleanly (lease expires, worker marks them failed)
- No data is lost — traces and artifacts are already in the DB
- The `/status` badge reverts to "Worker offline" within the heartbeat window (30 s)

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Worker won't register | `DATABASE_URL` reachable? `WORKER_TOKEN` valid? Scopes include `claim`? |
| Badge stays "Worker offline" | Worker logs show heartbeat? `/api/worker/status` returns worker list? |
| Live run fails immediately | LM Studio reachable from worker? Model loaded? Check worker logs for `agent.run` error. |
| Tool renders missing | Worker `artifacts` scope? Storage adapter configured? |
| Probe fails | VLM_DENTAL_PATH correct? Python deps installed? Run probe manually for details. |

## Recruiter-facing copy

> The live mode is attached only during arranged demos. The deployed site at
> https://dentalforge-app.vercel.app shows recorded runs by default — the
> full replay with every thought, tool call, and stored render is available
> without a worker. Live runs demonstrate the end-to-end connection when a
> worker is attached.

## Negative control

Stop LM Studio (`Ctrl+C` in LM Studio) → queue a live run → job fails with
retryable error "model unavailable" → worker backs off → restart LM Studio →
queue again → succeeds. This proves the failure mode is handled correctly.