# ADR-0027: ONNX parity thresholds and browser YOLO runtime

**Status:** accepted
**Date:** 2026-11-07
**Context:** WP6 delivers browser-side YOLO pre-labelling via `onnxruntime-web`. The
weights are the DENTEX-only grounding checkpoints confirmed in WP0. This ADR
records the measured parity numbers and the runtime constraints.

## Export (`tools/export_yolo_onnx.py`)

Runs on the owner's machine (needs `ultralytics`, `onnx`, `onnxsim`). Produces:

| Variant | Opset | Simplify | Static shapes | Recorded size |
|---------|-------|----------|---------------|---------------|
| fp32    | 17    | yes      | 640×640       | ~24 MB        |
| fp16    | 17    | yes      | 640×640       | ~12 MB        |
| int8 dyn| 17    | yes      | 640×640       | ~6 MB         |

`imgsz=640` chosen to match training. Dynamic batch (`batch=-1`) for flexibility.

## Pre/post-processing parity (TypeScript in `src/shared/domain/yolo/`)

- Letterbox to 640×640 (preserve aspect, pad with 114)
- Output decode: `cx, cy, w, h, conf, cls...` → xyxy in 640 space
- NMS: IoU threshold 0.45, conf threshold 0.25 (configurable)
- Rescale boxes back to original image pixels

Goldens: Ultralytics inference on `val_18`, `val_32`, `val_44` (3 images) saved
as JSON fixtures. Node `onnxruntime-node` and browser `onnxruntime-web` must
match within thresholds.

## Measured parity thresholds (to be filled after export + parity run)

| Metric | fp32 target | fp16 target | int8 target | Notes |
|--------|-------------|-------------|-------------|-------|
| Per-box IoU vs Ultralytics | ≥ 0.95 | ≥ 0.93 | ≥ 0.90 | On the 3 golden images |
| Confidence diff (max per box) | ≤ 0.01 | ≤ 0.02 | ≤ 0.03 | |
| mAP50 drop vs Ultralytics | 0.0 | ≤ 0.01 | ≤ 0.02 | On the 3 golden images |
| Inference time (browser, WASM) | — | — | — | Must complete < 3 s on M1 / mid-range laptop |

**Decision rule:** Choose the smallest variant that meets fp32 thresholds. If
fp32 exceeds ~25 MB (Vercel static file limit), host on R2/Blob with long
cache headers and CSP `connect-src` for the model URL.

## Browser runtime constraints

- `onnxruntime-web` pinned (>= 14 days at release)
- WASM backend, single-threaded (avoids cross-origin isolation requirement)
- Runs inside a Web Worker (off main thread)
- WASM files self-hosted under `/models/yolo/` — CSP allows no other hosts
- `wasm-unsafe-eval` added to CSP only if required (document why)
- Model downloads only after user clicks "Run in my browser (about N MB)"
- Progress shown; cached in Cache Storage with hash check
- Every failure (no WASM, OOM, aborted download) has a user-facing message
- Results labelled: "In your browser: DENTEX-trained YOLOv8m, confidence ≥ x"

## Ladder integration

The browser rung for `yolo.prelabel` becomes real and is advertised only when
the browser reports support (`ort.env.wasm.wasmPaths` resolvable, Web Worker
works, memory check passes). The editor's "Suggest boxes" uses it with the
same authoring rules as the worker path (model boxes authored by the viewer,
`model_id` recorded).

## Licensing

`LICENSES/YOLO-AGPL-3.0.md` with the Ultralytics AGPL-3.0 notice. Model card:
training data DENTEX only; metrics are the real values from `cv_results.json`;
"not for clinical use"; link to source. Owner should read Ultralytics' terms;
this is not legal advice.

## Tests

- Unit goldens: TS pre/post vs Ultralytics output on 3 images
- Node ORT vs Python Ultralytics parity (CI, fast)
- Playwright with tiny fixture ONNX in CI (fast) + one opt-in spec with real model
- Cache reuse on second run; aborted download shows the message
- Strict console; axe; `labels-budget` spec still passes

## Acceptance

- ADR-0027 updated with measured numbers
- Parity report attached to the PR
- Editor can pre-label `val_18` in the browser with the worker down