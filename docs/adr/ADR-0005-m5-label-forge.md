# ADR-0005: M5 LabelForge — annotation persistence, provenance, and replay tier

Date: 2026-10-05
Status: Accepted

## Context

M5 builds the `/labels` annotation editor (draw/resize FDI + pathology boxes),
review workflow (draft→submitted→approved/rejected with Cohen's κ), an
active-learning queue, and YOLO/COCO export. There is no backend yet (plan §5
platform comes later), and the plan's **graceful-degradation rule** (§9)
applies: every feature must resolve *how it runs* and label the result with
provenance (`worker_exact | browser_approx | import_replay | heuristic`).

Ground truth exists in the sibling `VLM-DENTAL` repo: the DENTEX
`quadrant-enumeration-disease` COCO file (705 train images) is the exact source
the committed trace fixtures' `ground_truth` came from — bbox-for-bbox.

## Decisions

### 1. GT fixtures are generated, never hand-written — and cross-checked against trace fixtures

`scripts/generate_m5_labels.py` reads the real DENTEX COCO JSON and the real
X-ray PNGs. Before writing anything it **asserts** that the GT it derives
(`category_id_1/2 + 1` via the single DENTEX conversion, `category_id_3` via the
`DENTEX_DEFAULT_DIAGNOSES` map from `run_zero_shot.py`) equals the GT already
committed in `fixtures/traces/verified_with_tools.json` (image 1, 13 boxes),
`verified_healthy.json` (image 3, 0 boxes), and `unverified_dentex.json`
(image 4, 14 boxes). A mismatch fails generation. `tests/m5-labels.test.ts`
repeats this cross-check in CI so label GT can never drift from trace GT.

### 2. Bboxes live in ORIGINAL dataset pixels; the shipped JPEG is a downscaled variant

Plan §4.3 requires `[x,y,w,h]` in native image pixels. The original images are
2744–2909px wide (3–6 MB PNG) — too heavy to commit. Each fixture stores
`width`/`height` (original pixel space of `gt` and `predictions`) **plus**
`variant_width`/`variant_height` (the committed ≤1600px JPEG in
`public/labels/`). The editor scales by `variant/original`; exports always use
original pixels. Never store coordinates in the variant space — one pixel
space for data, one scale factor for display.

### 3. Model pre-labels are real inference (replay tier), committed as fixtures

Plan §9's YOLO pre-label ladder: worker `yolo.prelabel` → browser ONNX →
**stored `predictions` rows** → disabled. We cannot run a worker or ship model
weights in the browser tier, so M5 executes the real committed
`data/models/yolo_cv_best` weights **once at generation time** and commits the
resulting boxes (`confidence`, `class_idx` 0–31, FDI-derived quadrant/position)
in each fixture. Provenance displayed in UI: `import_replay`. This is honest:
the boxes came from real inference on the real image — not fabricated.

The healthy image (id 3, 0 GT boxes) gets 19 predictions at mean conf 0.376 —
a genuine false-positive showcase that feeds the active-learning queue.

### 4. Human annotations persist in localStorage behind a storage adapter

No backend exists yet (§7 tables are the target). Human drafts/submissions are
stored under `df.labels.v1` in localStorage through
`src/shared/lib/annotationStore.ts`, which mimics the §7 `annotation_sets`
optimistic-concurrency contract (`version` token; a stale save returns a
`conflict` Result code instead of silently overwriting). When Postgres lands,
only this adapter changes — the zod contracts (`AnnotationSet`,
`ReviewDecision`) already match the planned tables 1:1.

Roles (`user|reviewer|admin`) and the `can()`/`canReview()` helpers exist as a
seed of plan §5.2 with a **demo role switcher** in the UI, explicitly labeled
as demo — no authentication is implied.

### 5. Agreement = greedy IoU(≥0.5) matching + Cohen's κ over matched labels

Two annotator sets on one image are matched greedily by descending IoU
(threshold 0.5, deterministic tie-break). Each matched pair contributes one
unit keyed by `FDI:normalized-pathology` (reusing M2's
`normalizeDentalDiagnosis`, so `"Deep Caries"` and `"deep caries"` agree);
unmatched boxes are units against `<missing>` (disagreement). κ is Cohen's
unweighted kappa; **`null` when undefined** (no units, or expected agreement
1.0) and the UI renders `n/a` — plan §0 forbids fabricating numbers.

### 6. Export runs fully in the browser (pure functions), zipped without dependencies

Plan §9 puts YOLO/COCO export at "server-side streaming zip" as the last
resort; with no server the browser tier wins by construction:
`yoloLines()` (32-class, normalized, `fdiToClassIdx`) and `cocoExport()`
(4 DENTEX pathology categories + FDI extras) are pure functions over
`approved|submitted` annotations, packed by a ~100-line store-only ZIP writer
(`src/shared/domain/zip.ts`, CRC-32 tables, fixed timestamps → deterministic
archives). No new npm dependency; the same functions will move into the §7
`dataset_exports` path unchanged.

### 7. Active-learning scores are heuristic and labeled as such

No `al.score` worker exists. `alQueueScore()` blends prediction uncertainty
(`1 − mean confidence`, from the real stored predictions) with GT coverage
gap, weight 0.7/0.3, and every UI surface stamps it `computed_by: heuristic`.

## Consequences

- `fixtures/labels/{1..5}.json` + `public/labels/{1..5}.jpg` are reproducible
  by re-running the generator; regeneration re-proves GT/trace consistency.
- DENTEX is **CC-BY-NC-SA-4.0**: the downscaled images are redistributed as a
  derivative for non-commercial research with attribution recorded in
  `fixtures/manifest.json` (`license` per entry) and shown in the UI footer.
- `tests/m5-labels.test.ts` locks: cross-fixture GT consistency, κ edge cases
  (null vs number), state machine, export formats, ZIP determinism.
- Total suite after M5: 110 tests.
