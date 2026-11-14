/**
 * Browser YOLO constants (ADR-0027).
 *
 * The model is a DENTEX-only YOLOv8m (fold 0) exported to ONNX fp16 at 640x640
 * and committed under `public/models/yolo/`. Size and digest are asserted by
 * `scripts/prepare-yolo-assets.mjs` at build time and shown in the UI before the
 * download, so the button never lies about how many bytes it will fetch.
 */
export const YOLO_MODEL = {
  /** Public URL of the ONNX graph (same origin, CSP `connect-src 'self'`). */
  url: "/models/yolo/yolov8m-dentex-fp16-640.onnx",
  /** Byte size of the committed file; also the download-progress denominator. */
  bytes: 51_878_944,
  /** SHA-256 of the committed file, verified after the download. */
  sha256: "f0fda3500765a43d5248207969bd537d0e7605adc95ef740baafa0486f9e3350",
  /** Label recorded as `model_id` on every box this runtime authors. */
  id: "yolov8m-dentex-fp16-640",
  /** Human-readable provenance line. */
  label: "DENTEX-trained YOLOv8m (fold 0), ONNX fp16, 640px",
  /** Square input side. */
  size: 640,
  /** Ultralytics' grey letterbox border, 0-255. */
  pad: 114,
  /** ADR-0027 decoding defaults. */
  confidenceThreshold: 0.25,
  iouThreshold: 0.45,
} as const;

/** Where the onnxruntime-web WASM loader and binary are copied to. */
export const YOLO_RUNTIME_DIR = "/models/yolo/ort/";

/** Cache Storage bucket for the model bytes (hash-checked on every load). */
export const YOLO_CACHE = "df.yolo.v1";

/** One byte per MiB, for the "about N MB" button label. */
export const YOLO_MODEL_MB = Math.round(YOLO_MODEL.bytes / 1024 / 1024);
