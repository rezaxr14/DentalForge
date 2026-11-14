/**
 * Message contract between the label editor and the YOLO Web Worker
 * (ADR-0027). Both sides import this file, so a field rename is a type error
 * rather than a silent `undefined` in a 3-second inference.
 */
import type { Detection } from "./detect";

export interface YoloRunRequest {
  type: "run";
  /** Same-origin URL of the radiograph to pre-label. */
  imageUrl: string;
  /** Native image size, so the boxes come back in dataset pixels. */
  width: number;
  height: number;
  confidenceThreshold: number;
  iouThreshold: number;
}

export interface YoloDisposeRequest {
  type: "dispose";
}

export type YoloWorkerRequest = YoloRunRequest | YoloDisposeRequest;

export interface YoloProgress {
  type: "progress";
  phase: "init" | "decode" | "infer";
}

export interface YoloResult {
  type: "result";
  boxes: Detection[];
  /** Wall-clock inference time inside the worker, milliseconds. */
  inferenceMs: number;
  /** Total time from request to result, milliseconds. */
  totalMs: number;
}

export interface YoloFailure {
  type: "error";
  /** Message safe to show in the editor. */
  message: string;
}

export type YoloWorkerResponse = YoloProgress | YoloResult | YoloFailure;
