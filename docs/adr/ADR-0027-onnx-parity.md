# ADR-0027: ONNX parity thresholds and browser YOLO runtime

**Status:** accepted 2026-11-14 — the export, the decoder, the worker and the
editor button exist, and every number below was measured on this machine.
**Date:** 2026-11-07 (revised 2026-11-11; rewritten 2026-11-14 with measurements)
**Context:** browser-side YOLO pre-labelling via `onnxruntime-web` using the
DENTEX-only grounding checkpoint, so the editor can suggest boxes on a machine
that has no worker and no database.

## What is built

| Piece | Where |
|---|---|
| Export (fp32 → fp16) | `scripts/export_yolo_onnx.py` (one-off, run outside CI): Ultralytics fp32 export, then the `onnxconverter_common` recipe below |
| Committed graph | `public/models/yolo/yolov8m-dentex-fp16-640.onnx`, **51,878,944 bytes (49.5 MiB)**, SHA-256 `f0fda350…f9e3350` |
| Decoder (letterbox, decode, NMS, rescale) | `src/shared/domain/yolo/detect.ts` |
| Web Worker | `src/shared/domain/yolo/worker.ts`, bundled to `public/models/yolo/worker.js` by `scripts/build-yolo-worker.mjs` |
| Main-thread handle | `src/shared/domain/yolo/client.ts` |
| Runtime assets | `scripts/prepare-yolo-assets.mjs` copies `ort.wasm.min.mjs`, `ort-wasm-simd-threaded.mjs` and `ort-wasm-simd-threaded.wasm` (11.9 MB) into `public/models/yolo/ort/` |
| Goldens | `scripts/export_yolo_golden.py` → `fixtures/yolo/val_{18,32,44}.json` |
| Ladder | `FEATURES["yolo.prelabel"].browserReady = true`; the editor passes a live capability check |
| Tests | `tests/m11-browser-yolo.test.ts` (decode parity), `e2e/browser-yolo.spec.ts` (real browser) |

The checkpoint is `data/models/dentex_only_fold_0/weights/best.pt` (52,090,194
bytes, 49.7 MiB); `cv_results.json` records five DENTEX-only folds with
`mean_map50` 0.932 and `mean_map50_95` 0.536. `data/models/yolo_cv_best` is
**not** used: VLM-DENTAL's own `docs/YOLO_CV_RESULTS.md` crowns that name for the
DENTEX+Tufts fold, and Tufts never enters a public artifact.

## Measured sizes

`imgsz=640`, opset 17, static shapes, simplify on.

| Variant | Size | Notes |
|---|---|---|
| fp32 | 103,697,245 B (98.9 MiB) | the reference export |
| fp16 | 51,878,944 B (49.5 MiB) | **shipped** |
| int8 (dynamic) | 26,294,123 B (25.1 MiB) | rejected: see below |

The fp16 conversion is not `model.export(half=True)` — that produced an
identical 98.9 MiB file, and the naive `onnxconverter_common` path produced a
graph ONNX Runtime refused to load (`Resize` output type mismatch). The working
recipe deletes stale `value_info`, converts with `op_block_list=["Resize"]`, and
re-runs shape inference. `onnxslim --dtype fp16` also produces a loadable fp16
graph, but a byte-different one (51,897,297 B), so it is not the shipped file.
Ultralytics stamps the export date into the graph metadata, so re-running
`scripts/export_yolo_onnx.py` reproduces the same graph (same size, identical
digest with `date` blanked) and a different raw file hash; the script compares
the blanked digest and the size.
The resulting graph keeps **float32 input and output** (`images` [1,3,640,640],
`output0` [1,36,8400]), so the browser feeds and reads fp32 and only the weights
are half precision.

int8 dynamic quantisation is rejected on measurement, not taste: per-box IoU
against the reference fell to **0.89–0.92** (below the 0.90 floor on one image),
the maximum confidence difference was **0.11–0.16** (limit 0.03), and
single-threaded CPU inference took **25 s** per image. Static QDQ quantisation
with a calibration set could do better, but it needs a calibration split and an
mAP run over that split, which is outside what this repository may run without
the owner's approval. fp16 is the smallest variant that meets the thresholds.

## Parity: conversion (identical input, PyTorch vs ONNX Runtime)

Reference is the PyTorch weights on the *same* 640x640 letterboxed tensor, so the
only variable is the export. Three held-out DENTEX validation images, conf 0.25,
NMS IoU 0.45, single-threaded CPU.

| Image | Boxes | fp32 min IoU | fp32 max conf Δ | fp16 min IoU | fp16 max conf Δ |
|---|---|---|---|---|---|
| `val_18` | 28 | 1.0000 | 0.000002 | 0.9833 | 0.00196 |
| `val_32` | 30 | 1.0000 | 0.000002 | 0.9845 | 0.00143 |
| `val_44` | 28 | 1.0000 | 0.000001 | 0.9822 | 0.00152 |

fp32 is box-for-box identical to PyTorch. fp16 keeps every box, mean IoU 0.992,
worst 0.982. Both clear the thresholds below.

Note what the reference is *not*: `model.predict()` letterboxes to a minimum
rectangle rounded to stride 32 (640x288 for a 3003x1316 radiograph), so comparing
against it directly reports min IoU 0.76 and confidence differences up to 0.45 —
that is the padding difference, not the export. The browser pads to a full
640x640 square, like the reference above, and the decoder is tested against it.

## Parity: end to end in Chromium (image 1 of the editor)

`e2e/browser-yolo.spec.ts` runs the whole path; the numbers come from driving the
real editor and asking the same worker for raw boxes.

| Comparison | Boxes | Matched | Min IoU | Mean IoU | Max conf Δ |
|---|---|---|---|---|---|
| browser (fp16, WASM) vs Python reference | 32 / 32 | 32 | 0.860 | 0.980 | 0.034 |

Every reference box is reproduced with the same tooth class. The residual comes
from image resampling, not from the model: the browser scales the radiograph with
Skia's filter, the reference with PIL's bilinear, and a 1-pixel edge difference on
a 126-pixel-wide box is already 0.02 IoU. For that reason the browser tier's
honest claim is "same boxes, `browser_approx`", which is exactly what the
provenance badge says.

## Thresholds and verdict

| Metric | fp32 target | fp16 target | Measured (fp16) | Verdict |
|---|---|---|---|---|
| Per-box IoU vs the PyTorch reference | ≥ 0.95 | ≥ 0.93 | 0.982 min, 0.992 mean | pass |
| Confidence diff (max per box) | ≤ 0.01 | ≤ 0.02 | 0.0020 | pass |
| mAP50 drop | 0.0 | ≤ 0.01 | not measured (needs a whole split: gated) | not claimed |
| Browser inference | < 3 s | < 3 s | **4.7 s** (Chromium, WASM single-thread, 8-core laptop) | **missed** |

The 3 s target was optimistic for single-threaded WASM. 4.7 s is what a user
waits after clicking, behind a progress label, with the UI still responsive
because it is a worker. Raising the target to 6 s, or shipping fp32 for accuracy
at the same speed (ORT casts fp16 to fp32 on the CPU anyway), were both rejected:
the download would double and buy nothing measurable.

## Decision: ship it from `public/`, not from R2

`public/models/yolo/` is served by Vercel as a static file at 49.5 MiB. The
alternative in the earlier draft - R2/Blob plus CSP `connect-src` for the model
URL - is unnecessary at this size and would have widened the CSP for a file that
never changes. The ONNX file is committed to git (one 49.5 MiB blob, no LFS); the
11.9 MB ORT runtime is copied from `node_modules` at build time instead of being
committed twice.

## Browser runtime constraints (as built)

- `onnxruntime-web` pinned at **1.23.2**, imported as `onnxruntime-web/wasm`
  (68 KB glue) so the app bundle never carries WebGL/WebGPU backends.
- WASM backend, `numThreads = 1`: no cross-origin isolation, no
  `SharedArrayBuffer`, so the site keeps its plain static-file headers.
- Runs inside a Web Worker. The worker is **pre-bundled with esbuild**, because
  Turbopack copies `new URL("./worker.ts", import.meta.url)` to `static/media/`
  as raw TypeScript instead of compiling it - verified by inspecting the build
  output, not assumed.
- WASM files self-hosted under `/models/yolo/ort/`; `connect-src 'self'` stays
  closed, and no third-party host is contacted.
- CSP gains **`'wasm-unsafe-eval'`** (not `'unsafe-eval'`): Chromium refuses
  `WebAssembly.instantiate` without it. `worker-src 'self'` is explicit. Pinned by
  `tests/csp.test.ts`.
- The graph downloads only after the user clicks **"Run in my browser (about
  49 MB)"**; the button label states the size before the click.
- The bytes are cached in Cache Storage (`df.yolo.v1`) and **SHA-256 verified on
  every load**; a corrupt cache entry is deleted and re-fetched.
- Every failure has a message: unsupported browser, HTTP error, hash mismatch,
  timeout (5 min), worker crash.
- Results are labelled "Ran DENTEX-trained YOLOv8m (fold 0), ONNX fp16, 640px in
  your browser: N boxes in T ms (provenance: browser_approx)".

## Ladder integration (as built)

The editor advertises the browser rung only when `browserYoloSupported()` is true
(Worker + WebAssembly + OffscreenCanvas + `createImageBitmap` +
`crypto.subtle.digest`), and passes that into `contextFor()` as
`browserSupported`. A browser that fails the check falls through to the stored
predictions instead of offering a 50 MB download that cannot work. Boxes are
authored by the viewer with `model_id = yolov8m-dentex-fp16-640`.

## Licensing

The ONNX graph is a derivative of Ultralytics YOLOv8m (AGPL-3.0) trained on
DENTEX (CC-BY-NC-SA-4.0), and it is now **redistributed** by this repository, so
the obligations are live: `THIRD_PARTY_NOTICES.md` names the licence, the source
(the VLM-DENTAL repository and the checkpoint path), the export script and the
non-commercial, not-for-clinical-use terms. `public/models/yolo/NOTICE.md` repeats
that next to the file. This is not legal advice.

## Tests

- `tests/m11-browser-yolo.test.ts` — decode parity against the Python reference
  on three golden images (177–221 candidate anchors each), letterbox geometry,
  NMS, preprocessing, capability wiring. No ORT, no 50 MB file, milliseconds.
- `e2e/browser-yolo.spec.ts` — real Chromium, no worker and no database: the
  ladder offers the browser rung, the click produces boxes with
  `browser_approx`, the second run reuses Cache Storage, console and CSP stay
  clean.
- The `labels-budget` perf spec is untouched and still passes: the browser run is
  off the main thread, so dragging 500 boxes is unaffected.

## Acceptance

- [x] Sizes and parity numbers measured and written into this ADR
- [x] Parity report in the PR body
- [x] Editor pre-labels an image in the browser with the worker down
      (`e2e/browser-yolo.spec.ts`, image 1; `val_18` is the golden-parity image)
- [ ] mAP50 over the validation split for the fp16 graph — needs the owner's
      approval for a whole-split run; not claimed anywhere
