# TraceForge — Implementation Plan

**Working name:** TraceForge (TraceLab + LabelForge combined). Placeholder; rename freely.
**Plan version:** 1.0 (written 2026-10-05)
**Audience:** a coding agent with access to the owner's local files (VLM-DENTAL repo, local traces and models) and the owner's private Hugging Face repos.
**Owner:** Reza Nadimi (github.com/rezaxr14)

---

## 0. Rules for the building agent (read first)

1. **Locked decisions (§2) are final.** Do not re-open them. If you must deviate, write an ADR in `docs/adr/` and tell the owner.
2. **Verify before you trust.** The schemas in §4 were derived by reading VLM-DENTAL source and docs. The real trace JSONL files were *not* available when this plan was written. Milestone M0 must validate every schema in §4 against the real local files and commit sanitized fixtures. Where reality differs, reality wins; update §4's zod schemas, not the data.
3. **Never hard-code metrics.** Every number shown in the UI must be computed from data or read from a data record. The VLM-DENTAL docs contain inconsistent numbers (for example YOLO mAP50 appears as 0.5901, 0.8695, 0.9376 and 0.9593 for different protocols) and many results tables are still `Pending`/`TBD` (SFT and GRPO have not been run as of 2026-10-04). Render empty states honestly.
4. **Graceful degradation is a hard requirement** (§9). The deployed app must boot, render and never throw to an error boundary when the Python worker, Redis or object storage is missing.
5. **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`, no `any`, no non-null assertions in feature code. Validate every boundary (HTTP, DB JSON columns, worker payloads, imported files) with zod.
6. **No secrets in the client bundle.** `HF_TOKEN` is used only by local import scripts and must never be set on Vercel.
7. **Work milestone by milestone** (§13). A milestone is done only when its Definition of Done checklist passes in CI.
8. **Small conventional commits.** One logical change per commit, tests included.
9. **This is not a medical product.** Show a persistent "Research prototype, not for clinical use" notice wherever model output about patients' radiographs is displayed. No PHI is stored. Do not make any image public before the dataset license has been checked (§12.4).

---

## 1. Purpose and scope

**Primary purpose:** a flagship portfolio project proving senior-level React/Next.js and full-stack skill, built around real AI-research artifacts (agent traces, evaluations, annotations) from the Dental-Agent project.

**Secondary purpose:** a real tool: it is the "Phase 6 clinical UI" from the VLM-DENTAL roadmap and a data-curation workbench.

**In scope (modules):**
- **Trace Explorer** (TraceLab): browse, replay, compare and audit multi-turn agent traces.
- **Eval Hub**: leaderboard with bootstrap CIs and calibration (ECE), per-case drill-down, run diff.
- **LabelForge**: annotation editor (boxes with FDI tooth number and pathology label), review workflow with inter-annotator agreement, active-learning queue, YOLO/COCO export.
- **Tool Lab**: run any of the 8 agent tools on an image.
- **Data-Quality dashboards**: verifier rejections, directive-leak scans, healthy-scan false positives, tool usage.
- **Reward Inspector**: recompute and inspect the GRPO reward components for any trajectory.
- **Live Agent view** (clinical UI): stream an agent run turn by turn, with replay fallback.
- **Training Hub**: checkpoint registry and metrics dashboards for SFT/GRPO/YOLO (mostly empty states until runs exist).
- **Platform**: multi-tenant orgs, roles, invites, worker management, audit log, theming.

**Out of scope:** model training or inference inside Vercel functions; polygons, segmentation masks, measurement tools; real-time multi-user co-editing of the same box (soft locks only); mobile-native apps.

---

## 2. Locked decisions (from the owner interview)

| # | Topic | Decision |
|---|---|---|
| D1 | Worker location | Unknown today, must support all: local RTX 4090 machine (no public URL), Colab/Kaggle sessions, rented/cloud GPU. **Therefore the worker is pull-based and outbound-only** (it polls the web app; the web app never calls the worker). |
| D2 | Offline behavior | Combination of: (a) clear disabled/offline status with precomputed replays, (b) in-browser compute where feasible (ONNX YOLO, canvas image tools), (c) precomputed replays. Implemented as the **capability ladder** in §9. |
| D3 | Data layer | Private Hugging Face repos are the source of truth; data is **imported into Postgres** (and images into object storage) for querying. |
| D4 | Access model | **Multi-tenant organizations** with roles `admin`, `annotator`, `reviewer`. |
| D5 | Repo | The web app is its **own repository** (the Python worker lives elsewhere and talks to it only through the versioned worker contract, §10). |
| D6 | Annotation scope | Boxes with FDI tooth number and pathology label only. No polygons, no measurements. |
| D7 | Visitor access | Normal sign-up with GitHub/Google, plus a **demo-org invite link**. No anonymous guest login. |
| D8 | React/Next showcase | All four: Server Components + streaming + PPR/caching; React 19 concurrent features (`useOptimistic`, transitions, Suspense); heavy client performance (virtualized lists, canvas editor, web workers); architecture quality (typed API contract, feature-sliced code, strict TS). |
| D9 | Look and feel | Clean light Vercel/Linear style with a dark-mode toggle. |
| D10 | Deployment | Must deploy to Vercel as-is, with no Python backend present. The owner can attach the PyTorch worker later at any time. |
| D11 | Scope additions | Tool Lab, Data-Quality dashboards and Live Agent view stay in scope (and so do the Reward Inspector and Training Hub). |

---

## 3. Defaults chosen by the planner (the owner may override any)

| Item | Default | Why |
|---|---|---|
| Framework | Next.js 16.x (pin the latest patched 16.x; Next now ships scheduled security releases, so enable Renovate/Dependabot and keep current), React 19.2, App Router | Current stable line |
| Package manager | pnpm | Speed, strictness |
| Styling/UI | Tailwind CSS v4, shadcn/ui on Radix, `next-themes`, Geist font, `cmdk` command palette | Matches the Vercel/Linear look |
| Database | Neon Postgres (serverless driver), branch-per-preview | Free tier, branching |
| ORM/migrations | Drizzle ORM + drizzle-kit | Type-safe, SQL-close |
| Auth | Better Auth with organization plugin (GitHub + Google OAuth). Any equivalent is fine if it supports orgs, roles and invites | Multi-tenant requirement |
| Object storage | Cloudflare R2 (S3 API) behind a `StorageAdapter` interface; Vercel Blob and local-disk adapters also implemented | Multi-GB images, cheap egress |
| Realtime | SSE route handlers fed by Upstash Redis streams; DB polling fallback when Redis is absent | Vercel cannot hold WebSockets |
| Client state | TanStack Query for server cache, Zustand for the editor store, React state elsewhere | |
| Editor engine | Custom Canvas2D engine (framework-agnostic `EditorEngine` class, React only for chrome), two stacked canvases + HTML overlay | Shows skill, full control of perf |
| In-browser ML | `onnxruntime-web` (WebGPU, WASM fallback) in a Web Worker | |
| Charts | visx + d3-scale (calibration plots, histograms); Recharts acceptable for simple bars | |
| Lists | TanStack Virtual | |
| Testing | Vitest, Testing Library, MSW, Playwright (+ axe), contract tests, k6 for load | |
| Observability | `@vercel/otel` (OpenTelemetry), pino structured logs, optional Sentry | |
| Demo org | One shared "Demo Org" (reset daily by Vercel Cron) containing only license-permitted images; the invite link grants role `annotator` | |
| i18n | English only in v1, but **use CSS logical properties everywhere** so Persian (fa, RTL) is a cheap stretch milestone (M13) | Owner has RTL experience |

---

## 4. Source-system reference (what the app models)

### 4.1 Where the data lives

| Asset | Location |
|---|---|
| Verified traces (22 canonical files, ~170 MB, not in git) | Private HF dataset `Reza-Nadimi/vlm-dental-traces` (sync script in VLM-DENTAL: `scripts/sync_traces_hf.py --download`) |
| Models (YOLO best fold, SFT/GRPO adapters) | Private HF `Reza-Nadimi/vlm-dental-models` with subfolders `yolo_cv/`, `sft/`, `grpo/` |
| Tufts images + polygons | Private HF `Reza-Nadimi/tufts-train-images` |
| DENTEX images | Per-image HF layout produced by `scripts/upload_dataset_images_to_hf.py` (inspect the owner's HF account to confirm the repo name) |
| Zero-shot eval JSONL (8 models) | VLM-DENTAL `data/evaluations/zero_shot_<dataset>_<split>_<provider>_<model>.jsonl` |
| YOLO CV results | `data/evaluations/10_models_eval.csv`, `data/models/dentex_grounding_tool_cv_best/cv_results.json` (`data/models/benchmark_comparative_evaluation.json` contains stale ~0.10 numbers; do not use) |
| Demo/replay assets | `docs/images/255_t3_turn*_i*_*.png` (a complete 23-turn case study, trace 255), `data/traces/analysis_charts/**`, `data/sample_images/validation_data/quadrant_enumeration_disease/xrays/val_{18,32,44}.png`, `data/tool_verification/val_*_{annotated,zoom_crop,contrast_enhanced}.png` |

### 4.2 Domain glossary
- **OPG**: panoramic dental radiograph, about 2872×1504 px on disk.
- **FDI notation**: two-digit tooth number. Quadrant 1–4 (1 = upper right, 2 = upper left, 3 = lower left, 4 = lower right, *patient's* side; patient's right appears on the viewer's left) then position 1–8 (central incisor to third molar). A tooth is `quadrant*10 + position`, e.g. 46.
- **DENTEX 0-index quirk (critical):** raw DENTEX `category_id_1` (quadrant) is 0–3 and `category_id_2` (position) is 0–7. FDI = raw + 1. Implement exactly one `dentexRowToFdi()` function in `shared/domain/fdi.ts` and a lint rule forbidding hand-written `+ 1` on these fields. Other datasets (Tufts) already deliver 1-indexed FDI; never apply the conversion to them (double increment bug).
- **Pathology classes (DENTEX):** `Impacted`, `Caries`, `Periapical Lesion`, `Deep Caries`. Tufts native taxonomy: `Periapical`, `Non-Odontogenic`, `Pericoronal`, `Inter-Radicular`. Store both `raw_diagnosis` and a normalized `diagnosis` (port `normalize_dental_diagnosis` from `dental_agent/evaluation/metrics.py`; note models emit variants like `Impacted Tooth`).
- **YOLO class index:** 32 classes, one per FDI tooth: `class_idx = (quadrant-1)*8 + (position-1)`; inverse is trivial. Implement and unit-test both directions.
- **bbox format:** `[x, y, w, h]` in **native image pixels** everywhere (tools, ground truth, traces, annotations). Never store canvas coordinates.
- **Canonical views (model-side only):** FULL 1536×768, CROP 256×384, COMPARE 512×384. Tools always execute on the native image; only the *view shown to the model* is resized. The web app uses these sizes only for the `full_1536` image variant and for labeling what the model saw.
- **Cohorts (10 total, 1,847 images, 3,694 traces):** each of {DENTEX pathology 678, DENTEX healthy 27, Tufts overlap pathology 202, Tufts healthy 660, Tufts all-diseases 280} exists as a *with-tools* (multi-turn, mean about 12–13 turns, up to 35) and a *no-tools* (single-turn) trace set. Healthy cohorts have `final_answer: []`.

### 4.3 Trace record (verified JSONL line)
Derived from `verify_pending()` in `dental_agent/training/trace_generation.py`: a verified line is the trajectory dict with extra keys merged in.

```ts
// Draft zod schema: validate against real files in M0, keep .passthrough() on unknown keys.
const Bbox = z.tuple([z.number(), z.number(), z.number(), z.number()]); // [x,y,w,h] native px

const Finding = z.object({
  quadrant: z.number().int().min(1).max(4),
  tooth_position: z.number().int().min(1).max(8),
  diagnosis: z.string(),
  confidence: z.number().min(0).max(1).optional(),   // present on predictions
  bbox: Bbox.optional(),                              // present on ground truth
});

const ToolCallRecord = z.object({
  tool_name: z.string(),
  tool_args: z.record(z.unknown()),
  tool_ok: z.boolean(),
  tool_error: z.string().optional(),
  true_bbox: Bbox.optional(),                  // only when a perturbation fired (audit only)
  perturb_tier: z.enum(["small", "big"]).optional(),
}).passthrough();

const Turn = z.object({
  turn: z.number().int(),
  raw_output: z.string(),
  parsed: z.object({                           // null when unparseable
    thought: z.string().optional(),
    tool_calls: z.array(z.object({ tool: z.string(), args: z.record(z.unknown()) })).optional(),
    final_answer: z.array(Finding).optional(),
  }).passthrough().nullable(),
  status: z.string(),   // seen: tool_executed, tool_all_failed, final_answer, rejected_final_answer, multi_blob_dump, ...
  tool_calls_this_turn: z.array(ToolCallRecord).optional(),
}).passthrough();

const VerifiedTrace = z.object({
  image_id: z.number().int(),
  image_path: z.string(),                       // machine-specific (Kaggle/Colab/Windows). NEVER use to locate images.
  dataset: z.string().default("dentex"),        // "dentex" | "tufts" | ...
  ground_truth: z.array(Finding),               // [] for healthy scans
  turns: z.array(Turn),
  tool_calls: z.number().int(),                 // total count
  final_answer: z.array(Finding).nullable(),
  messages: z.array(z.unknown()),               // chat transcript
  format_ok: z.boolean(),
  verifier_reason: z.string().optional(),
}).passthrough();
```

Facts the importer must respect:
- **Images are not stored in traces.** `to_jsonable()` serializes PIL images as the literal string `"<Image>"`. Tool-output images (crops, windowed views, contrast, denoise, contralateral composites) must be **re-rendered** from the native image + `tool_args`. This drives the whole artifact strategy in §9 (precompute via worker, re-render in browser, or replay).
- **Resolve images by `(dataset, image_id)`**, never by `image_path`.
- Unverified files (`train_cot_traces_unverified.jsonl`) wrap the trajectory: `{image_id, image_path, ground_truth, status: "unverified"|"generation_failed", trajectory | failure_reason, partial_trajectory}`. Import them only if present, tagged `verified=false`.
- Canonical file names: `train_cot_traces.jsonl` and `train_cot_traces_no_tools.jsonl` (880 each = 678 DENTEX + 202 Tufts) plus per-cohort files: `train_cot_traces_dentex[_no_tools].jsonl`, `_healthy_dentex[_no_tools]`, `_tufts[_no_tools]`, `_healthy_tufts[_no_tools]`, `_tufts_all[_no_tools]`. The hybrid files duplicate the per-cohort files: **dedupe by `(dataset, image_id, mode, cohort)` plus a content hash**.
- `locate_tooth` during trace generation returns **ground-truth boxes** (`note: "GT-Grounded"`), then a perturbation (tiers: none 45%, small 25%, big 30%) is applied to the *shown* box. `true_bbox` + `perturb_tier` in the call record are audit data and the basis of the perturbation-audit view.

### 4.4 Agent tools (8) — exact signatures
`bbox` is `[x,y,w,h]` native px. "Output" says whether the tool returns an image (needs rendering) or data (already in the call record).

| Tool | Args (defaults) | Output | Model-view family |
|---|---|---|---|
| `zoom_crop` | `bbox`, `padding_frac=0.25` | image | CROP |
| `window_level` | `preset` (bone, enamel, soft_tissue, metal_reduction), optional `center`, `width` overriding the preset | image | FULL |
| `locate_tooth` | `tooth` (FDI int) | data `{tooth, bbox, confidence, note?}` | n/a |
| `fdi_label` | `quadrant`, `tooth_position` | data (FDI label) | n/a |
| `denoise` | `method` (bilateral or median), `strength=0.6` (0–1) | image | FULL |
| `contralateral_compare` | `bbox`, `quadrant` (mirror search constrained to the same jaw half: upper 1–2, lower 3–4) | image (side-by-side) | COMPARE |
| `enhance_contrast` | `factor=1.5` (multiplicative) | image | FULL |
| `nudge_crop` | `bbox`, `dx_frac=0`, `dy_frac=0`, `scale=1.0` | data `{bbox}` (pair with `zoom_crop` to view) | n/a |

Tool implementations to port or call: `dental_agent/tools/{zoom_crop,windowing,grounding,fdi,denoise,contralateral,contrast,nudge}.py`; registry in `registry.py`.

### 4.5 Evaluation records (zero-shot JSONL)
Per line (verified keys): `image_id, dataset, split, provider, model, ground_truth[], predictions[] (with confidence), matched_pairs[] ({gt, pred, fdi_match, exact_match, closeness, spatial, diag_sim}), fdi_precision/recall/f1, exact_precision/recall/f1, closeness_score, spatial_proximity, diagnostic_similarity, fdi_correct, quadrant_correct, tooth_position_correct, diagnosis_correct, exact_match, all_exact_match, final_answer, raw_output, format_ok, finish_reason, confidence, timestamp`.

Metrics to port from `dental_agent/evaluation/metrics.py` (function names): `expected_calibration_error` (alias `compute_ece`), `normalize_dental_diagnosis`, `extract_predicted_findings`, `compute_finding_closeness`, `match_multi_findings` (set-level matching across *all* findings; never truncate ground truth to the first finding), `compute_evaluation_metrics`, `compute_diagnostic_metrics`, `bootstrap_metric_ci`, `bootstrap_paired_diff_ci`.

**Concrete acceptance test (already checked by the planner):** averaging `exact_f1` and `fdi_f1` over each JSONL reproduces the VLM-DENTAL leaderboard exactly, e.g. Kimi-k3 `exact_f1` 0.222 / `fdi_f1` 0.321, Gemini 3.5 Flash 0.188 / 0.319, Qwen3.5-9B base 0.112 / 0.204 (49 cases), LLaMA 3.2 11B 0.010 / 0.077. The Eval Hub must reproduce these to three decimals and reproduce the other leaderboard columns (exact-match accuracy, 95% CI, closeness, ECE) from the ported functions; if any column cannot be reproduced, document why in an ADR instead of fudging.

### 4.6 GRPO reward (port with golden-file parity)
`dental_agent/rewards/composite.py::combine_reward` = `1.0*accuracy + 0.2*format + 0.2*tool_validity + 0.1*efficiency` by default; components in `rewards/components.py`: `reward_accuracy` (greedy highest-pair-score-first matching of predicted to *all* ground-truth findings, F1-style harmonic mean of recall and precision, hallucinated extras count as 0), `reward_format`, `reward_tool_validity`, `reward_efficiency` (reference budget 6 calls per distinct located tooth; `locate_tooth` and `nudge_crop` exempt; only exceeding the budget or exact back-to-back repeated calls cost anything). Weights live in `config.RewardWeights`.

### 4.7 Known quirks to surface in the UI instead of hiding
- Docs disagree on YOLO metrics because the protocols differ (raw `model.val()` vs target-filtered CV vs held-out target benchmark). The app shows each with its protocol label.
- "Best model" selection (DENTEX+Tufts fold 1, 0.9593) was made on the same 50-image held-out set it is reported on; show the 5-fold means next to it.
- Some results tables in the docs are targets, not results. Only render values present in data files.

---

## 5. Architecture

```
                         ┌──────────────────────────────── Vercel ────────────────────────────────┐
 Browser                 │  Next.js 16 (RSC, streaming, server actions, route handlers)           │
 ┌──────────────────┐    │   ├─ /app/**            UI (feature-sliced)                            │
 │ React 19 UI      │◄──►│   ├─ /api/worker/v1/**  worker contract (pull-based, token auth)       │
 │ Canvas editor    │    │   ├─ /api/jobs/**       job create/status/SSE events                   │
 │ Web Workers:     │    │   └─ /api/images/**     authorized image gateway                       │
 │  stats, imageops,│    └───────┬──────────────┬───────────────┬────────────────────────────────┘
 │  onnx (YOLO)     │            │              │               │
 └──────────────────┘     Neon Postgres   Upstash Redis     R2 / Blob / local
                          (system of      (optional: SSE     (images, variants,
                           record)         fan-out, rate      artifacts, ONNX model)
                                           limit, presence)
                                     ▲
                                     │  HTTPS, outbound-only from the worker
                          ┌──────────┴───────────┐
                          │ Python worker (any)  │  local GPU box / Colab / Kaggle / cloud
                          │  polls /jobs/claim   │  (optional: app is fully usable without it)
                          └──────────────────────┘
      Local scripts (owner machine): `pnpm import:hf|local`  HF/disk ──► Postgres + R2
```

Principles:
- **Postgres is the system of record.** Redis is a convenience layer; everything must work without it.
- **The worker is optional and replaceable.** The web app never depends on one being online (§9).
- **Large payloads never pass through Vercel functions** (request bodies are limited to a few MB): uploads and artifacts use presigned URLs.
- **Server-first rendering:** pages are Server Components; interactivity is added as small client islands. Heavy client code (editor, ONNX, stats) is dynamically imported and lives in dedicated routes.

### 5.1 Realtime
- Job progress and agent turns: append-only `job_events` table (monotonic `seq` per job) + best-effort publish to a Redis stream.
- `GET /api/jobs/:id/events` is an SSE stream with `Last-Event-ID` resume; it reads from Redis when available and from Postgres otherwise. Respect `maxDuration`; close cleanly before the limit and let `EventSource` auto-reconnect.
- `GET /api/jobs/:id/events?after=<seq>` is the plain polling fallback; the client hook `useJobStream(jobId)` switches automatically after repeated SSE failures.
- Presence and "who is editing this image" use the same transport; if Redis is missing, presence is simply hidden.

### 5.2 Tenancy and authorization
- Every business table has `org_id`. All DB access goes through a repository layer `scoped(orgId)`; direct `db.select()` calls in features are lint-forbidden.
- Roles (per organization): `admin` (everything, members, invites, worker tokens, imports, exports), `annotator` (create/edit own annotations, submit for review, cannot approve own work), `reviewer` (approve/reject/adjudicate, edit during adjudication, cannot approve own work). All roles can read traces, evals and dashboards of their org.
- Authorization is a single pure function `can(role, action, resource)` with exhaustive unit tests; server actions and route handlers call it, UI hides controls with the same function.
- Mandatory automated test: **cross-tenant isolation suite** (user from org A can never read, write or enumerate org B data via any route, server action, SSE channel, image URL or worker token).
- RLS in Postgres is a documented hardening stretch, not required for v1.

### 5.3 Images
- Import produces variants with `sharp`: `original` (as-is), `full_1536` (1536×768, webp), `thumb_320` (webp).
- `GET /api/images/:id/:variant` checks membership, then redirects to a short-lived presigned URL (or streams, for the local adapter). Cache headers: `private, max-age` with ETag.
- The editor loads `full_1536` first, then upgrades to `original` for zoom levels above 1:1.
- Content-hash keys (`sha256`) make import idempotent and dedupe the DENTEX/Tufts overlaps.

---

## 6. Repository layout (feature-sliced; enforced by ESLint boundaries)

```
traceforge/
├─ src/
│  ├─ app/                         # routes only; thin
│  │  ├─ (marketing)/              # landing, architecture page, license/notice
│  │  ├─ (auth)/sign-in, invite/[token]
│  │  ├─ org/[orgSlug]/
│  │  │   ├─ traces/  traces/[traceId]/  traces/compare
│  │  │   ├─ evals/   evals/[runId]/     evals/diff
│  │  │   ├─ labels/  labels/[imageId]   labels/review  labels/queue  labels/export
│  │  │   ├─ tools/   quality/   rewards/   agent/   training/
│  │  │   └─ settings/(members|invites|workers|audit|datasets)
│  │  └─ api/
│  │      ├─ auth/[...all]/  worker/v1/**  jobs/**  images/**  export/**  health/
│  ├─ features/                    # one folder per module; no cross-feature imports
│  │  ├─ traces/ evals/ annotation/ review/ tool-lab/ quality/ rewards/
│  │  ├─ agent-live/ training/ jobs/ admin/ capability/
│  │  └─ <feature>/{ui,model,api,lib,index.ts}
│  ├─ entities/                    # trace, annotation, image, job, worker, org, eval-run
│  ├─ shared/
│  │  ├─ ui/ (design system wrappers)   ├─ domain/ (fdi.ts, classes.ts, bbox.ts, metrics/, rewards/)
│  │  ├─ contracts/ (zod: worker API, imports, events)   ├─ db/ (drizzle schema, repositories)
│  │  ├─ storage/ (adapters)   ├─ realtime/   ├─ config/ (env validation)   └─ lib/
│  └─ browser-workers/             # stats.worker.ts, imageops.worker.ts, onnx.worker.ts
├─ drizzle/                        # migrations
├─ scripts/                        # import (hf|local), seed, golden-fixtures verification, export-onnx docs
├─ examples/
│  ├─ mock-worker/                 # TS worker speaking the real contract, deterministic, used by e2e
│  └─ python-worker/               # reference Python worker skeleton (handlers stubbed; see §10.6)
├─ e2e/  tests/  fixtures/         # Playwright, Vitest, sanitized real-data fixtures + golden outputs
└─ docs/ (adr/, architecture.md, worker-contract.md, degradation.md, runbook.md, performance.md)
```

Layer rule: `app → features → entities → shared`. Features may not import other features; cross-feature composition happens in `app`. Enforce with `eslint-plugin-boundaries` and fail CI on violations.

---

## 7. Data model (Postgres, Drizzle)

All tables have `id` (uuid v7), `created_at`, and `org_id` unless noted. Add indexes on every `(org_id, …)` access path.

**Identity/tenancy:** `users`, `organizations`, `memberships(user_id, org_id, role)`, `invites(org_id, role, token_hash, expires_at, max_uses, uses)`, `audit_log(org_id, actor_id, action, resource, meta jsonb)`, `worker_tokens(org_id, name, token_hash, scopes, last_used_at, revoked_at)`.

**Library:** `datasets(org_id, name, source: dentex|tufts|upload, license_note)`, `images(dataset_id, source_image_id int, content_hash, width, height, storage_key, split)` unique on `(dataset_id, source_image_id)`, `image_variants(image_id, variant, storage_key, width, height, bytes)`.

**Annotations (LabelForge):**
- `annotations(image_id, set_id, bbox_x, bbox_y, bbox_w, bbox_h, fdi_quadrant, fdi_position, pathology, source: gt_import|model|human, model_id, confidence, status: draft|submitted|approved|rejected, version int, author_id, created_by, updated_at)`
- `annotation_sets(image_id, assignee_id, state, version int, submitted_at)` (version = optimistic-concurrency token)
- `review_tasks`, `review_decisions(annotation_id, reviewer_id, decision, reason)`, `agreement_stats(image_id, annotator_a, annotator_b, matched, kappa, pct_agree)`
- `predictions(image_id, model_id, boxes jsonb, mean_conf, min_conf, entropy, created_by_job)` (precomputed pre-labels = the replay tier for YOLO)
- `queue_scores(image_id, strategy, score, computed_by: worker|heuristic)`
- `dataset_exports(org_id, format: yolo|coco, filter jsonb, storage_key, counts jsonb)`

**Traces (TraceLab):**
- `traces(dataset_id, image_id, cohort, mode: with_tools|no_tools, verified bool, source_file, content_hash, n_turns, n_tool_calls, format_ok, verifier_reason, ground_truth jsonb, final_answer jsonb)` unique on `(dataset_id, image_id, cohort, mode)`; GIN index on `ground_truth` optional.
- `trace_turns(trace_id, idx, status, thought, raw_output, parsed jsonb)`
- `tool_calls(turn_id, idx, tool_name, args jsonb, ok, error, shown_bbox jsonb, true_bbox jsonb, perturb_tier, result jsonb, artifact_id)`
- `artifacts(org_id, kind: tool_image|agent_image|report|model|export, storage_key, mime, width, height, bytes, sha256, provenance: worker_exact|browser_approx|import_replay)`

**Evaluation:** `eval_runs(org_id, dataset, split, provider, model, canonical_resize, n, source_file, summary jsonb)`, `eval_cases(run_id, image_id, ground_truth jsonb, predictions jsonb, matched_pairs jsonb, fdi_f1, exact_f1, closeness, confidence, format_ok, raw_output)`, `model_registry(org_id, name, kind: yolo|vlm|api, stage: zero_shot|sft|grpo|yolo, hf_path, onnx_artifact_id, meta jsonb)`.

**Quality:** `quality_events(org_id, kind: verifier_reject|directive_leak|healthy_fp|spatial_drift, trace_id nullable, cohort, detail jsonb, source: scan|import|docs_seed)`.

**Jobs/workers:** `workers(org_id, name, runtime, software jsonb, capabilities jsonb, status, last_heartbeat_at)`, `jobs(org_id, type, version, payload jsonb, status: queued|claimed|running|succeeded|failed|cancelled|expired, priority, attempts, max_attempts, lease_expires_at, claimed_by, idempotency_key, result jsonb, error jsonb, created_by)`, `job_events(job_id, seq, type, data jsonb, created_at)` unique `(job_id, seq)`.

**Training:** `training_runs(org_id, kind: sft|grpo|yolo, name, config jsonb, status)`, `training_metrics(run_id, step, name, value, ts)`, `reward_samples(run_id, step, trajectory_ref, components jsonb, total)`.

Claiming a job must be a single atomic statement (`UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING …`). Lease reaping is **lazy** (done inside claim/heartbeat/read paths); do not rely on cron, because Vercel Hobby cron is daily only.

---

## 8. Technology notes the agent must verify against current docs
Next.js 16 evolves quickly; confirm flags in the docs for the *pinned* version before using them: Cache Components / `use cache` (and `cacheComponents` config) vs. PPR, React Compiler (`reactCompiler`), Turbopack defaults, `proxy.ts` (formerly middleware) conventions, async `params`/`searchParams`, and how streaming metadata behaves. Record any API you had to look up in `docs/adr/` so the choices are explainable in interviews.

---

## 9. Graceful degradation (hard requirement)

### 9.1 Principle
Every feature that can use the worker resolves **how it will run** through one service and renders from the answer. Nothing calls the worker directly from UI code, and nothing throws when the worker is absent.

### 9.2 Capability ladder
`resolveStrategy(feature, ctx) → 'worker' | 'browser' | 'replay' | 'unavailable'` (plus the reason). Order is fixed: **worker (exact) → browser (approximate, parity-tested) → replay (precomputed) → unavailable (clear status)**.

| Feature | worker | browser | replay | when nothing works |
|---|---|---|---|---|
| YOLO pre-label | job `yolo.prelabel` (exact) | ONNX YOLO in a Web Worker (needs an uploaded ONNX model artifact; provenance `browser_approx`) | stored `predictions` rows (from an earlier batch job) | button disabled with reason + "queue for later" |
| Trace tool images | job `trace.render_artifacts` (exact) | re-render from native image + args with the browser tool ports | `artifacts` rows from import (e.g. trace 255 assets) | labeled placeholder frame with args shown as text |
| Tool Lab | `tool.execute` (exact) | canvas/WebWorker ports of 6 image tools; pure-math ports of `fdi_label` and `nudge_crop` | the stored `val_18/32/44` tool outputs | disabled tool with reason; `locate_tooth` falls back to ONNX or replay |
| Live Agent | `agent.run` streaming | none (a VLM cannot run in browser) | animated replay of a recorded trace at original pacing | explanation + link to Trace Explorer |
| Eval run on a new model | `eval.run` | none | previously imported runs remain fully browsable | "queue run" creates a persistent `queued` job; UI shows "Waiting for a worker" |
| Active-learning scores | `al.score` | none | stored `queue_scores` | heuristic ordering (fewest approved boxes, lowest agreement), labeled *heuristic* |
| Bootstrap CIs, ECE, κ, reward recompute | not needed | Web Worker (pure TS) | n/a | n/a |
| YOLO/COCO export | not needed | n/a | n/a | server-side streaming zip |

Every result carries `provenance` (`worker_exact | browser_approx | import_replay | heuristic`) and the UI shows a small badge. **Browser-approximate results must never be written back as authoritative data** (for example never saved as the "official" tool image of a trace).

### 9.3 Worker status model
- `online`: heartbeat within 30 s. `degraded`: heartbeat within 120 s. `offline`: otherwise or none ever registered.
- Status is derived on read (no cron). The capabilities a worker declares at registration (job types, versions, available model ids) are intersected with the feature being requested.
- A global status pill in the app shell shows `Worker: online / degraded / offline`, with a popover listing capabilities and last seen time.

### 9.4 Implementation rules
1. `features/capability` exports `<CapabilityGate feature="tool.execute" fallback={...}>` and a server helper `getStrategy(feature)`.
2. Server actions and route handlers return a typed `Result<T, { code: 'unavailable'|'forbidden'|'invalid'|'conflict'|'internal'; reason: string }>`; **they never throw for expected conditions**. Unexpected errors are logged, reported and mapped to `internal`.
3. Every route group has `error.tsx` and `loading.tsx`; every async server component sits inside its own `Suspense` boundary with a skeleton.
4. Env validation (`shared/config/env.ts`, zod): the app boots with only `DATABASE_URL` and auth variables. Missing Redis → polling mode. Missing storage → local `public/demo-assets` adapter. `WORKER_MODE=off|mock|live` (default `off` on Vercel).
5. A **chaos switch** for tests: `?__chaos=worker-off|redis-off|storage-off` (enabled only when `NODE_ENV !== 'production'` or a signed owner cookie), used by Playwright.
6. Jobs queued while no worker is online stay `queued` (no expiry for 7 days by default) and run when a worker connects; the UI shows queue position and "waiting for a worker".

### 9.5 Required tests
- Playwright suite `degradation.spec.ts`: with `WORKER_MODE=off`, visit **every** route in the app and assert: HTTP 200, no uncaught console errors, no error boundary rendered, every worker-dependent control shows its fallback state.
- Same suite with Redis off and storage off.
- Contract tests prove a late-connecting worker drains the queue in order and that expired leases requeue.

---

## 10. Worker contract v1 (the only coupling to the Python side)

Base path `/api/worker/v1`. Auth: `Authorization: Bearer tf_wrk_<random>` (stored hashed, scoped to one org, admin-created, revocable). Header `X-Contract-Version: 1` required; unknown major versions get `426`. Errors are `application/problem+json` (RFC 9457). All writes accept an `Idempotency-Key`. Publish the schema as `GET /api/worker/v1/openapi.json` generated from the zod contracts (`zod-to-openapi`), and keep `docs/worker-contract.md` in sync via a CI check.

### 10.1 Lifecycle endpoints
| Method + path | Purpose |
|---|---|
| `POST /register` | `{name, runtime: 'local-gpu'\|'colab'\|'kaggle'\|'cloud', software:{python,torch,cuda,vlmDentalCommit}, capabilities:[{job, versions:[1], models?:string[]}]}` → `{workerId, pollIntervalMs, leaseSeconds, serverTime}` |
| `POST /heartbeat` | `{workerId, status:'idle'\|'busy', load?:{gpuUtil,vramMb}}` → `{cancelJobIds:string[]}` |
| `POST /jobs/claim` | `{workerId, accepts:string[], max:1, waitMs≤20000}` (long-poll) → `{jobs:[{id,type,version,payload,attempt,leaseExpiresAt,idempotencyKey}]}` |
| `POST /jobs/:id/events` | `{events:[{seq,type:'progress'\|'log'\|'turn'\|'artifact'\|'partial',data}]}` (also extends the lease) |
| `POST /jobs/:id/artifacts/presign` | `{name,mime,bytes,sha256}` → `{artifactId, uploadUrl, headers}`; the worker PUTs directly to storage |
| `POST /jobs/:id/complete` | `{result, artifactIds[]}`; server validates `result` against the job type's schema |
| `POST /jobs/:id/fail` | `{error:{code,message,retryable}}` |
| `GET /images/:imageId?variant=original` | short-lived presigned download URL |
| `POST /models/register` | `{name, kind, stage, hfPath, meta}` (and ONNX artifact id when exported) |
| `POST /ingest/eval-run` | batch of eval case rows (same shape as the zero-shot JSONL) + run summary; idempotent by content hash |
| `POST /ingest/traces` | batch of verified traces (§4.3 shape); idempotent by content hash |
| `POST /ingest/metrics` | training metrics `{runId, step, name, value}[]` and reward samples |

Worker robustness requirements (Colab/Kaggle sessions die): leases default 60 s and are renewed by events/heartbeats; an expired lease returns the job to `queued` (attempts + 1, up to `max_attempts` then `failed`); results are idempotent; the worker may crash at any point without corrupting state.

### 10.2 Job types (v1) — payload → result
```ts
// yolo.prelabel
payload: { imageId, modelId, confThreshold?: number /*0.25*/ }
result:  { modelId, inferenceMs, boxes: { bbox: Bbox, conf: number, classIdx: number,
           fdiQuadrant: number, fdiPosition: number }[] }

// tool.execute  (tools always run on the NATIVE image; `view` only affects the returned render)
payload: { imageId, tool: ToolName, args: Record<string, unknown>, view?: 'native'|'canonical' }
result:  { kind: 'image'|'data', data?: unknown, artifactId?: string, width?: number, height?: number, durationMs: number }

// agent.run  (streams one `turn` event per turn, payload = full Turn record of §4.3, plus tool images as artifacts)
payload: { imageId, modelId: string, mode: 'with_tools'|'no_tools', maxTurns?: number, maxToolCalls?: number,
           canonicalResize?: boolean, seed?: number }
result:  { finalAnswer: Finding[], nTurns: number, nToolCalls: number, formatOk: boolean,
           rewardComponents?: { accuracy: number, format: number, toolValidity: number, efficiency: number } }

// eval.run  (streams `partial` events with case rows)
payload: { modelId, dataset: string, split: string, canonicalResize?: boolean, imageIds?: number[] }
result:  { runId: string, n: number, summary: Record<string, number> }

// trace.render_artifacts  (re-render tool images of an imported trace; exact)
payload: { traceId } ; result: { artifacts: { turnIdx: number, callIdx: number, artifactId: string }[] }

// al.score
payload: { imageIds: string[], modelId } ; result: { scores: { imageId, meanConf, minConf, entropy, nBoxes }[] }

// parity.golden  (dev only: produces golden outputs for browser-port parity tests)
payload: { imageIds: number[], tools: ToolName[] } ; result: { fixtures: { tool, args, imageId, artifactId, sha256 }[] }
```

### 10.3 Mock worker (required, ships in `examples/mock-worker`)
A separate TypeScript process that speaks the **real HTTP contract** and answers all job types deterministically from fixtures (trace 255 assets, `val_*` tool outputs, canned YOLO boxes). `WORKER_MODE=mock` starts it for dev and e2e. It exists so the whole app, including streaming and job queues, is testable and demo-able without a GPU.

### 10.4 Reference Python worker (ships in `examples/python-worker`, stubs only)
A small `httpx` loop: register → heartbeat thread → long-poll claim → handler registry keyed by job type → events → presigned upload → complete/fail. Handlers import nothing from VLM-DENTAL by default (clear `NotImplementedError` stubs with docstrings naming the VLM-DENTAL function each handler should call, e.g. `tool.execute` → `ToolRegistry.create_default()`, `yolo.prelabel` → `tool_locate_tooth`/Ultralytics, `agent.run` → `dental_agent/agent/loop.py::run_agent`). Config via `TRACEFORGE_URL` and `TRACEFORGE_TOKEN`. README sections: run locally, run on Colab, run on Kaggle. The owner will wire real handlers later; that is a separate task.

---

## 11. Module specifications (remaining and upgraded work)

Every module must: (a) render with `WORKER_MODE=off`, (b) read data through a `DataSource` interface so the fixture/replay source and the Postgres source are interchangeable, (c) label provenance on computed or rendered results, (d) ship with unit tests and one Playwright flow.

### 11.1 Trace Explorer (upgrade of the M1 version)
- **List** (`/org/:slug/traces`): virtualized (TanStack Virtual), URL-state filters (dataset, cohort, mode, verified, final status, perturbation tier, tool used, n_turns range), server-side pagination and sorting, saved views. Streams the first page, then hydrates filters.
- **Detail** (`/traces/:id`): three panes. *Timeline* (turns, status chips, tool-call pills), *image canvas* (native image with overlays: shown `locate_tooth` bbox, `true_bbox` ghost box and offset arrow when a perturbation fired, final-answer boxes with FDI + diagnosis + confidence, ground-truth boxes toggle), *inspector* (thought text, raw JSON, verifier reason, ground truth vs final answer table using the ported matcher, per-trace reward breakdown).
- **Replay mode**: step or autoplay through turns (1x/2x, keyboard `←/→/space`), tool images appear as each turn completes. This is also the offline fallback of the Live Agent view.
- **Compare**: with-tools vs no-tools trace of the same `(dataset, image_id)` side by side (the corpus is 1:1 paired).
- **Tool images** follow the §9 ladder (stored artifact → browser re-render via the Tool Lab ports → placeholder).
- **Done when:** a 1,800+ row list scrolls at 60 fps, filters round-trip through the URL, and the trace-255 case study replays end to end from stored assets with the worker off.

### 11.2 Eval Hub
- Leaderboard computed from `eval_cases` (acceptance values in §4.5), sortable, with 95% bootstrap CIs computed in a Web Worker (progressive: point estimate first, CI streams in). Show the PRNG caveat from ADR-0002 in a tooltip.
- Reliability diagram and ECE (visx), per-case drill-down with matched pairs overlaid on the image, error taxonomy (FDI wrong / diagnosis wrong / hallucinated / missed).
- **Run diff**: choose two runs; paired bootstrap CI of the difference on shared cases; case-level "who won" table.
- YOLO results table with the **protocol label** for every number (raw `model.val()`, target-filtered CV, held-out benchmark). Never merge protocols into one column.

### 11.3 LabelForge
**Editor (`/labels/:imageId`)**
- Engine: framework-agnostic `EditorEngine` (Canvas2D; image layer + overlay layer + HTML label layer; pan/zoom with wheel and pinch; `requestAnimationFrame` render loop that redraws only dirty rects). React renders only the chrome.
- Tools: draw box, select/move/resize (8 handles), delete, duplicate-to-mirror (copies a box to the contralateral tooth), pan. Boxes stay inside image bounds. Coordinates are native pixels.
- Labeling: FDI quick entry (type two digits `4` `6` to set tooth 46; `Tab` cycles boxes), pathology hotkeys (1–4), an odontogram widget showing which of the 32 FDI slots are labeled/conflicting, duplicate/conflict warnings.
- History: event-sourced command stack (Create/Update/Delete/SetLabel/Batch) with drag coalescing; unlimited undo/redo within a session.
- Persistence: debounced batches of ops with `baseVersion`; server applies atomically and returns the new version; on `409` the client rebases and shows a non-blocking conflict toast. `useOptimistic` for label edits in the side panel, `useTransition` for image switching, prefetch and decode of the next queue image.
- Soft lock: one annotator per image task (`annotation_sets.assignee_id`); presence shown when Redis exists.
- Accessibility: complete keyboard operation, plus an accessible table view of all boxes with editable cells (the canvas alone is not accessible).
- Performance budget: 64 boxes at 60 fps; stress test with 500 boxes stays above 30 fps; input-to-paint under 16 ms for drag.

**Review workflow**: annotator submits a set; reviewer sees a diff against model/GT suggestions, approves/rejects boxes with reasons; two-annotator mode computes box matching (IoU ≥ 0.5, greedy by IoU) and **Cohen's κ** on pathology and FDI labels plus % agreement; disagreements enter an adjudication queue. Approving your own work is forbidden by `can()`.

**Pre-labeling (ladder in §9.2)**: "Suggest boxes" resolves worker → ONNX in browser → stored predictions. Suggestions are `source=model`, `status=draft`, and carry confidence; the UI visually distinguishes them from human boxes.

**Active-learning queue**: score = weighted blend of `1 - meanConf`, box-count deficit vs expected, and inter-annotator disagreement; worker `al.score` when available else the heuristic (badge *heuristic*). A chart tracks labeled-count vs detector mAP when training metrics exist.

**Export**: YOLO (`class_idx = (q-1)*8 + (p-1)`, normalized xywh) and COCO, as a server-side streaming zip, filterable by status (`approved` only by default). Round-trip test: import the export back and compare.

### 11.4 Tool Lab (extend M4)
Done in M4: browser ports for 7 of 8 tools with bit-exact goldens. Remaining: wire the §9 ladder (worker exact → browser → stored `val_*` outputs), add a provenance badge, add `locate_tooth` through ONNX/worker/replay, history panel of tool calls with bbox overlays, and ingest the 154 parity renders in `docs/images/` as replay assets.

### 11.5 Data-Quality dashboards
- **Fix required (see §15 R1):** a *directive leak* is defined by VLM-DENTAL as the **assistant's** text matching `LEAK_PATTERNS` in `scripts/patch_and_regenerate_traces.py` (teacher directive, ground truth, "per directive", "in the hint", "told to find", …). Port those patterns and scan **assistant** messages and `parsed.thought` only. The string `TEACHER DIRECTIVE` inside the stored *user* message is the generation scaffold, not a leak; report it separately as "teacher scaffold present in stored messages (expected)".
- Panels: leak scan (by cohort, file, pattern), verifier rejections (taxonomy: hallucinated pathology on healthy scans, GT contradiction, bbox drift; seeded from the audit table in `docs/PAPER_MILESTONES.md` and labeled `docs_seed` until real rejection logs are imported), status distribution, unknown/invalid tool names, perturbation tiers, healthy false positives, turn and tool-call histograms.
- All counts are unique cases after dedupe (ADR-0003 follow-up) with the raw-row count shown beside them.

### 11.6 Reward Inspector
Trace picker or live rollout → four components + weighted total (ported, golden-tested). Editable weights (sliders) recompute instantly; matched-pair visualization on the image; efficiency budget meter (6 calls per located tooth). Compare two trajectories of the same image.

### 11.7 Live Agent view (clinical UI)
Pick an image (library or upload) → `agent.run` job → stream turns over SSE → show each tool image, thought text, final structured report and overlay boxes with FDI/diagnosis/confidence. Persistent research-use banner. Offline: replay of a stored trace with a clear "worker offline, replaying a recorded run" banner. "Save as trace" ingests the run into the library.

### 11.8 Training Hub
Checkpoint registry read from the HF model repo (server-side, cached, revalidated), run pages with loss/reward/KL charts from `training_metrics`. SFT and GRPO have not been run, so default to honest empty states ("No runs yet") instead of invented numbers.

### 11.9 Admin
Members, roles, invite links (signed, expiring, use-limited), worker tokens (shown once), worker status, dataset import history, audit log, demo-org reset.

---

## 12. Non-functional requirements

### 12.1 Performance budgets (measured and recorded in `docs/performance.md`)
LCP < 2.0 s and INP < 200 ms on dashboards (throttled mid-tier mobile profile); route JS budgets enforced in CI (shell < 120 kB gz; editor route loaded on demand); no layout shift from skeletons; images use the right variant; bootstrap and ECE never block the main thread; ONNX model loads lazily with progress and caches in Cache Storage.

### 12.2 Accessibility
WCAG 2.2 AA. axe in Playwright on every route in light and dark mode; focus-visible styles; reduced-motion respected; live regions announce streamed turns politely; color is never the only signal (box status uses shape/label too).

### 12.3 Security
Security headers and a strict CSP; CSRF protections on server actions; origin checks; rate limits on auth, invites, worker endpoints (Upstash if present, in-memory otherwise); worker tokens stored hashed; presigned URLs short-lived and scoped; upload validation (type, size, dimensions, decode test); audit log for privileged actions; dependency audit in CI; automated cross-tenant isolation tests (§5.2).

### 12.4 Data, licensing and privacy
- Treat radiographs as sensitive: private buckets, no public image URLs, no PHI, no EXIF/metadata retained.
- **Before any image is shown to non-members (including the Demo Org), confirm the license terms of the DENTEX and Tufts datasets and of each repo asset.** If redistribution is not allowed, the Demo Org ships derived data only (annotations, metrics, traces without images) plus stored replay assets that are clearly permitted.
- The committed `fixtures/` must stay free of images and of any private identifiers; keep sanitization checks in CI.

### 12.5 Testing
Vitest unit tests for domain code; **golden-file parity tests against the Python implementation are the project's signature** (keep regenerating goldens through the existing `scripts/generate_*_goldens.py`, and make CI fail if a golden changes without an ADR); MSW for HTTP; contract tests for the worker API against the mock worker; Playwright for core flows, degradation, multi-tenant isolation and a11y; k6 for ingestion and SSE load; mutation testing optional on `shared/domain`.

### 12.6 Observability
`@vercel/otel` spans around server actions, DB calls and job lifecycle; request ids propagated to job events; structured logs; a `/api/health` endpoint reporting DB/Redis/storage/worker state (no secrets); a runbook in `docs/runbook.md`.

---

## 13. Milestones and status (supersedes any earlier numbering)

Status as of commit `c9f5402` (2026-10-05). M0–M4 were built ahead of this section, in a fixture-first order that is **accepted** because it delivers verified domain logic before infrastructure.

| # | Milestone | Status | Definition of Done (summary) |
|---|---|---|---|
| M0 | Validate schemas against real VLM-DENTAL files; sanitized fixtures | **Done** | zod schemas match real data; deviations in ADR-0001; fixtures + tests |
| M1 | Fixture-backed Trace Explorer + Eval Hub | **Done (basic)** | list/detail/leaderboard render from fixtures; upgraded in M10/M11 |
| M2 | TS ports of metrics + rewards with golden parity | **Done** | FDI/class-index, matching, ECE, rewards exact; bootstrap statistical |
| M3 | Data-quality dashboard from a full trace scan | **Done, needs fix** | see R1: leak definition is wrong |
| M4 | Tool Lab with Python-parity goldens | **Done** | 7/8 tools bit-exact; `locate_tooth` deferred |
| M5 | Correctness and repo hygiene pass | **Done** | R1 fixed; README replaced; `test`/`typecheck`/`ci` scripts; GitHub Actions; self-host fonts; ADR dates fixed; fold ADR-0001 deviations back into §4 |
| M6 | Platform foundation | **Done** | Neon + Drizzle migrations; Better Auth with orgs, roles, invites; env validation with optional services; repository layer; design system + light/dark theme; cross-tenant isolation tests green |
| M7 | Importer + DataSource switch | **Done** | `pnpm import:local` idempotent; counts match source (1,645 images, 3,694 trace rows after dedupe, 8 eval runs, ADR-0008); pages read Postgres in prod and fixtures in demo/offline mode; dedupe stats replace the row-count caveat |
| M8 | Jobs, worker contract, capability ladder | **Mostly done** (ADR-0009) | Done: Postgres queue with leases/fencing, contract v1 + generated docs, mock + Python workers, SSE with polling fallback, `/status` + header pill, HTTP-level `pnpm smoke` and `pnpm e2e:worker`. **Open:** features consuming the ladder, Redis fan-out, 501 ingest endpoints, token admin UI, Playwright specs |
| M9 | LabelForge editor core | Planned | §11.3 editor with perf budget and accessible table view; autosave with versioning |
| M10 | Review, agreement, queue, export | Planned | κ and agreement tested on fixtures; YOLO/COCO round-trip test; audit log |
| M11 | Pre-label ladder + Trace Explorer/Eval Hub upgrades | Planned | worker/ONNX/replay YOLO; virtualized lists; replay mode; run diff; reliability diagram |
| M12 | Live Agent, Reward Inspector completion, Training Hub | Planned | §11.6–11.8 |
| M13 | Polish and launch | Planned | perf/a11y budgets in CI; Lighthouse CI; README with architecture diagram, GIFs, ADR index; Vercel production deploy with Demo Org; optional Persian/RTL |

Each milestone ends with: typecheck, lint, unit, e2e green in CI; docs updated; ADRs for deviations; a short demo note in `docs/changelog.md`.

---

## 14. Deployment and environment

**Platforms:** Vercel (app), Neon (Postgres, branch per preview), Cloudflare R2 (images/artifacts/ONNX), Upstash Redis (optional). Self-host fonts (`geist` package or `next/font/local`) so builds never depend on Google Fonts reachability.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Neon pooled URL |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | yes | |
| `GITHUB_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET` | yes (at least one provider) | |
| `INVITE_SIGNING_SECRET` | yes | signs invite links |
| `STORAGE_PROVIDER` | no | `r2` \| `blob` \| `local` (default `local`) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | when `r2` | |
| `UPSTASH_REDIS_REST_URL/TOKEN` | no | missing → polling mode |
| `WORKER_MODE` | no | `off` (default on Vercel) \| `mock` \| `live` |
| `DEMO_ORG_SLUG` | no | enables the demo-org invite flow and daily reset |
| `HF_TOKEN` | **never on Vercel** | local import scripts only |

Operational notes: run migrations in the deploy pipeline (not at runtime); one daily Vercel Cron (demo-org reset) is the only scheduled job; keep SSE routes inside `maxDuration`; never proxy large uploads through functions; `/api/health` is the uptime probe.

---

## 15. Risks and open items

| ID | Item | Action |
|---|---|---|
| **R1** | **Quality dashboard mislabels the generation scaffold as "Directive leaks"** (counts every trace containing `TEACHER DIRECTIVE` in `messages`, producing ~100% "leak"). VLM-DENTAL's own definition scans *assistant* text with `LEAK_PATTERNS` and reports 0 leaks. | Fix in M5 per §11.5; fix ADR-0003's "100% systemic" conclusion. |
| **R2** | **Possible real contamination in the SFT input path (verify, do not assume).** `dental_agent/training/sft.py::__getitem__` (about lines 685–704) rebuilds the first user turn from the *stored* user text and removes only "[Earlier tool result omitted" items. If the stored first user message really contains the teacher directive with ground-truth findings, SFT would train on a prompt that includes the answer, and inference would not have it. | Owner/agent: inspect real records (which message index holds `TEACHER DIRECTIVE`) and confirm the SFT path strips it. If not, fix `sft.py` and add a regression test **in VLM-DENTAL**; surface the result in the Quality dashboard. |
| R3 | Image licensing for the Demo Org (§12.4) | Verify DENTEX/Tufts terms before any non-member sees images. |
| R4 | ONNX export parity (letterbox size, NMS, class mapping) | Parity test vs Python predictions on `val_18/32/44`; label results `browser_approx`. |
| R5 | Colab/Kaggle session lifetimes | Lease/requeue design (§10.1); idempotent results. |
| R6 | Deferred ports: `extract_predicted_findings`, `compute_evaluation_metrics`, `compute_diagnostic_metrics` | Add goldens, then port; until then the leaderboard must not display columns that depend on them. |
| R7 | `nudge_crop` rounding ties (half-even vs half-away) | Add a golden with a `.05` tie and align. |
| R8 | Bootstrap CIs differ from numpy (PRNG) by up to 0.06 | Keep the tooltip; consider a seeded PCG port if exact reproduction is wanted. |
| R9 | Next.js 16 API churn and security releases | Pin, track releases, record API lookups in ADRs. |
