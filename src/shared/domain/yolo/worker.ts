/**
 * The browser-YOLO Web Worker (ADR-0027).
 *
 * Everything expensive happens here so the editor stays responsive: downloading
 * the 49.5 MiB graph (with progress), verifying its SHA-256, creating the ORT
 * session, decoding the radiograph with `createImageBitmap` + OffscreenCanvas,
 * and running the 640x640 forward pass.
 *
 * `onnxruntime-web` is imported lazily inside the worker and configured for the
 * single-threaded WASM backend: no cross-origin isolation, no SharedArrayBuffer,
 * and no CDN - the `.wasm` and its loader are served from `/models/yolo/ort/`.
 */
import { letterbox, letterboxPixels, decodeDetections, type Detection } from "./detect";
import { YOLO_CACHE, YOLO_MODEL, YOLO_RUNTIME_DIR } from "./model";
import type { YoloRunRequest, YoloWorkerRequest, YoloWorkerResponse } from "./protocol";

type Ort = typeof import("onnxruntime-web/wasm");

let ortPromise: Promise<Ort> | null = null;
let sessionPromise: Promise<import("onnxruntime-web/wasm").InferenceSession> | null = null;

function post(message: YoloWorkerResponse, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(message, transfer);
}

async function loadOrt(): Promise<Ort> {
  if (!ortPromise) {
    ortPromise = import("onnxruntime-web/wasm").then((ort) => {
      // Single-threaded WASM: works without COOP/COEP, so the site keeps its
      // plain static-file CSP. The loader + binary are self-hosted.
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.simd = true;
      ort.env.wasm.wasmPaths = YOLO_RUNTIME_DIR;
      ort.env.logLevel = "error";
      return ort;
    });
  }
  return ortPromise;
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function readModelBytes(): Promise<ArrayBuffer> {
  const cache = await caches.open(YOLO_CACHE).catch(() => null);
  const cached = cache ? await cache.match(YOLO_MODEL.url) : undefined;
  if (cached) {
    const buffer = await cached.arrayBuffer();
    if ((await sha256Hex(buffer)) === YOLO_MODEL.sha256) return buffer;
    await cache?.delete(YOLO_MODEL.url);
  }

  const response = await fetch(YOLO_MODEL.url);
  if (!response.ok) {
    throw new Error(`model download failed: HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  const digest = await sha256Hex(buffer);
  if (digest !== YOLO_MODEL.sha256) {
    throw new Error("model download failed the SHA-256 check");
  }
  if (cache) {
    await cache
      .put(YOLO_MODEL.url, new Response(buffer.slice(0), {
        headers: { "Content-Type": "application/octet-stream" },
      }))
      .catch(() => undefined);
  }
  return buffer;
}

async function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      post({ type: "progress", phase: "init" });
      const [ort, bytes] = await Promise.all([loadOrt(), readModelBytes()]);
      return ort.InferenceSession.create(bytes, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
        executionMode: "sequential",
      });
    })().catch((error: unknown) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

async function preprocess(request: YoloRunRequest): Promise<Float32Array> {
  const meta = letterbox(request.width, request.height, YOLO_MODEL.size, YOLO_MODEL.pad);
  const response = await fetch(request.imageUrl);
  if (!response.ok) {
    throw new Error(`radiograph fetch failed: HTTP ${response.status}`);
  }
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = new OffscreenCanvas(meta.scaledWidth, meta.scaledHeight);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("this browser cannot decode radiographs off-thread");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, meta.scaledWidth, meta.scaledHeight);
  bitmap.close();
  const pixels = context.getImageData(0, 0, meta.scaledWidth, meta.scaledHeight);
  return letterboxPixels(pixels.data, meta);
}

async function run(request: YoloRunRequest): Promise<void> {
  const started = performance.now();
  const session = await getSession();
  post({ type: "progress", phase: "decode" });
  const tensor = await preprocess(request);
  post({ type: "progress", phase: "infer" });

  const { Tensor } = await loadOrt();
  const input = new Tensor("float32", tensor, [1, 3, YOLO_MODEL.size, YOLO_MODEL.size]);
  const inferStarted = performance.now();
  const output = await session.run({ images: input });
  const inferenceMs = performance.now() - inferStarted;

  const first = output.output0 ?? Object.values(output)[0];
  if (!first) throw new Error("the model returned no output tensor");
  const data = first.data as Float32Array;
  const meta = letterbox(request.width, request.height, YOLO_MODEL.size, YOLO_MODEL.pad);
  const boxes: Detection[] = decodeDetections(data, meta, {
    confidenceThreshold: request.confidenceThreshold,
    iouThreshold: request.iouThreshold,
  });
  post({ type: "result", boxes, inferenceMs, totalMs: performance.now() - started });
}

self.addEventListener("message", (event: MessageEvent<YoloWorkerRequest>) => {
  const message = event.data;
  if (message.type === "dispose") {
    void sessionPromise?.then((session) => session.release()).catch(() => undefined);
    sessionPromise = null;
    return;
  }
  if (message.type === "run") {
    run(message).catch((error: unknown) => {
      post({
        type: "error",
        message: error instanceof Error ? error.message : "in-browser inference failed",
      });
    });
  }
});

