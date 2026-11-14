/**
 * Bundle the browser-YOLO Web Worker into `public/models/yolo/worker.js`.
 *
 * Next's bundlers do not agree on `new Worker(new URL("./worker.ts", import.meta.url))`:
 * Turbopack copies the raw `.ts` file to `static/media/` instead of compiling
 * it, so the browser would be handed TypeScript source. Building the worker with
 * esbuild keeps ONE source of truth in TypeScript, produces a plain ES module the
 * browser can load from a stable same-origin URL, and keeps the app bundle free
 * of onnxruntime-web (the editor only pays for the 68 KB glue; the WASM binary
 * and the model are fetched on demand).
 *
 * Run by `predev` and `prebuild`; the output is gitignored.
 */
import { build } from "esbuild";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "public", "models", "yolo", "worker.js");

await build({
  entryPoints: [join(root, "src", "shared", "domain", "yolo", "worker.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  legalComments: "none",
  splitting: false,
  logLevel: "warning",
});

console.log(
  `build-yolo-worker: public/models/yolo/worker.js ${(statSync(outfile).size / 1024).toFixed(1)} KiB`,
);
