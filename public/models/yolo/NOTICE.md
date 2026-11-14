# Browser YOLO model - licence and provenance

`yolov8m-dentex-fp16-640.onnx` (51,878,944 bytes, SHA-256
`f0fda3500765a43d5248207969bd537d0e7605adc95ef740baafa0486f9e3350`) is an ONNX
export of the **DENTEX-only** YOLOv8m fold-0 checkpoint
(`data/models/dentex_only_fold_0/weights/best.pt` in the upstream VLM-DENTAL
repository, 52,090,194 bytes). It is **not** the `yolo_cv_best` checkpoint: that
name belongs to the DENTEX+Tufts fold, and Tufts never enters this repository.

- **Weights licence:** GNU Affero General Public License v3.0 (Ultralytics
  YOLOv8m). The corresponding source is the upstream VLM-DENTAL repository
  (training script `scripts/train_grounding_tool.py`, checkpoint path above) and
  the export recipe in `scripts/export_yolo_onnx.py`; see ADR-0027.
- **Training data licence:** DENTEX, CC BY-NC-SA 4.0. The weights are therefore
  **non-commercial** and **not for clinical use**.
- **Metrics:** the DENTEX-only family records `mean_map50` 0.932 and
  `mean_map50_95` 0.536 in `cv_results.json`. Conversion parity (fp16 vs the
  PyTorch weights on identical input): 0.982 worst / 0.992 mean per-box IoU.
- **Runtime:** `onnxruntime-web` 1.23.2, WASM backend, single-threaded, inside a
  Web Worker. The runtime files in `ort/` are MIT-licensed and copied from
  `node_modules` at build time (`scripts/prepare-yolo-assets.mjs`).

Do not add Tufts-derived weights here, and do not reuse this file for clinical
decision-making.
