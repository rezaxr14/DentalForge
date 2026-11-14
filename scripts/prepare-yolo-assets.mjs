/**
 * Copy the onnxruntime-web WASM runtime into `public/models/yolo/ort/` and check
 * the committed ONNX graph (ADR-0027).
 *
 * The 49.5 MiB model is committed; the ~12 MB ORT runtime is not, because it is
 * already in `node_modules` and copying it at build time keeps the repository
 * from carrying a second copy of a dependency. Vercel runs `pnpm build`, which
 * runs this script through `prebuild`, so the deployed site serves both from its
 * own origin - no CDN, and `connect-src 'self'` stays true.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = join(root, "public", "models", "yolo", "ort");
const modelPath = join(root, "public", "models", "yolo", "yolov8m-dentex-fp16-640.onnx");

/** Exactly what `ort.env.wasm.wasmPaths` needs for the single-threaded WASM build. */
const RUNTIME_FILES = [
  "ort.wasm.min.mjs",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
];

const MODEL_BYTES = 51_878_944;
const MODEL_SHA256 = "f0fda3500765a43d5248207969bd537d0e7605adc95ef740baafa0486f9e3350";

function fail(message) {
  console.error(`prepare-yolo-assets: ${message}`);
  process.exit(1);
}

if (!existsSync(modelPath)) {
  fail(
    `missing ${modelPath}\n` +
      "The ONNX export is committed; restore it with `git lfs`-free checkout or rebuild it with " +
      "`python scripts/export_yolo_onnx.py` (see docs/adr/ADR-0027-onnx-parity.md).",
  );
}

const size = statSync(modelPath).size;
if (size !== MODEL_BYTES) {
  fail(`model is ${size} bytes, expected ${MODEL_BYTES}`);
}
const digest = createHash("sha256").update(readFileSync(modelPath)).digest("hex");
if (digest !== MODEL_SHA256) {
  fail(`model sha256 is ${digest}, expected ${MODEL_SHA256}`);
}

mkdirSync(runtimeDir, { recursive: true });
for (const file of RUNTIME_FILES) {
  const from = join(root, "node_modules", "onnxruntime-web", "dist", file);
  if (!existsSync(from)) {
    fail(`missing ${from} - run \`pnpm install\` first`);
  }
  copyFileSync(from, join(runtimeDir, file));
}

console.log(
  `prepare-yolo-assets: model ${(size / 1048576).toFixed(1)} MiB ok; ` +
    `copied ${RUNTIME_FILES.length} onnxruntime-web files to public/models/yolo/ort/`,
);
