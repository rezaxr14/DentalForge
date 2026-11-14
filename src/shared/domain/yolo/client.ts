/**
 * Main-thread handle for the browser-YOLO worker (ADR-0027).
 *
 * The editor never touches `onnxruntime-web` directly: it asks this module to
 * run one image, gets progress callbacks while the 49.5 MiB graph is fetched and
 * the forward pass runs, and receives boxes in original image pixels.
 */
import type { Detection } from "./detect";
import { YOLO_MODEL } from "./model";
import type { YoloWorkerRequest, YoloWorkerResponse } from "./protocol";

export interface BrowserRunOptions {
  imageUrl: string;
  width: number;
  height: number;
  confidenceThreshold?: number;
  iouThreshold?: number;
  /** Called when the worker reports a new phase; `null` means done. */
  onProgress?: (phase: "init" | "decode" | "infer" | null) => void;
}

export interface BrowserRunResult {
  boxes: Detection[];
  inferenceMs: number;
  totalMs: number;
}

/** Download + init + inference budget. A slow link is not an error, a hang is. */
const TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Everything the runtime needs, checked without side effects so the ladder can
 * refuse the browser rung instead of failing after a 50 MB download.
 */
export function browserYoloSupported(): boolean {
  if (typeof window === "undefined") return false;
  return (
    typeof Worker !== "undefined" &&
    typeof WebAssembly !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap === "function" &&
    typeof crypto?.subtle?.digest === "function"
  );
}

/** Human-readable reason the browser rung is unavailable, or null when it is. */
export function browserYoloBlocker(): string | null {
  if (typeof window === "undefined") return "Not in a browser.";
  if (typeof WebAssembly === "undefined") return "This browser has no WebAssembly.";
  if (typeof Worker === "undefined") return "This browser has no Web Workers.";
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") {
    return "This browser cannot decode images off the main thread.";
  }
  return null;
}

export class BrowserYolo {
  private worker: Worker | null = null;

  private pending: {
    resolve: (result: BrowserRunResult) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    onProgress?: BrowserRunOptions["onProgress"];
  } | null = null;

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker("/models/yolo/worker.js", { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<YoloWorkerResponse>) => {
      const message = event.data;
      if (!this.pending) return;
      if (message.type === "progress") {
        this.pending.onProgress?.(message.phase);
        return;
      }
      const { resolve, reject, timer, onProgress } = this.pending;
      this.pending = null;
      clearTimeout(timer);
      onProgress?.(null);
      if (message.type === "result") {
        resolve({ boxes: message.boxes, inferenceMs: message.inferenceMs, totalMs: message.totalMs });
      } else {
        reject(new Error(message.message));
      }
    });
    worker.addEventListener("error", (event) => {
      this.fail(new Error(event.message || "the YOLO worker crashed"));
      this.worker?.terminate();
      this.worker = null;
    });
    this.worker = worker;
    return worker;
  }

  private fail(error: Error): void {
    if (!this.pending) return;
    const { reject, timer, onProgress } = this.pending;
    this.pending = null;
    clearTimeout(timer);
    onProgress?.(null);
    reject(error);
  }

  run(options: BrowserRunOptions): Promise<BrowserRunResult> {
    if (!browserYoloSupported()) {
      return Promise.reject(new Error(browserYoloBlocker() ?? "in-browser inference is unavailable"));
    }
    if (this.pending) {
      return Promise.reject(new Error("an in-browser run is already in progress"));
    }
    const worker = this.ensureWorker();
    const request: YoloWorkerRequest = {
      type: "run",
      imageUrl: options.imageUrl,
      width: options.width,
      height: options.height,
      confidenceThreshold: options.confidenceThreshold ?? YOLO_MODEL.confidenceThreshold,
      iouThreshold: options.iouThreshold ?? YOLO_MODEL.iouThreshold,
    };
    return new Promise<BrowserRunResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error("in-browser inference timed out"));
      }, TIMEOUT_MS);
      this.pending = {
        resolve,
        reject,
        timer,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      };
      worker.postMessage(request);
    });
  }

  dispose(): void {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    worker.postMessage({ type: "dispose" } satisfies YoloWorkerRequest);
    worker.terminate();
    this.fail(new Error("in-browser inference was cancelled"));
  }
}
