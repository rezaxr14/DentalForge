"use client";

/**
 * M5 human-annotation persistence — localStorage adapter standing in for the
 * plan §7 `annotation_sets` table until Postgres lands (ADR-0005 §4).
 *
 * Contract: optimistic concurrency via a `version` token. A save built on a
 * stale version returns `{ ok: false, code: "conflict" }` — never a silent
 * overwrite (plan §9.4 Result rule).
 */
import { z } from "zod";
import {
  Annotation, AnnotationSet, AnnotationStatus, ReviewDecision,
} from "../contracts/labels";

const KEY = "df.labels.v1";
const ROLE_KEY = "df.role.v1";
const AUTHOR = "demo_user"; // no auth yet — ADR-0005 §4

/** Minimal storage surface so tests can inject an in-memory backend. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function backend(custom?: StorageLike): StorageLike | null {
  if (custom) return custom;
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

const StoreShape = z.object({
  sets: z.record(z.string(), AnnotationSet),
  decisions: z.record(z.string(), z.array(ReviewDecision)),
  roles: z.record(z.string(), z.enum(["user", "reviewer", "admin"])),
});
type Store = z.infer<typeof StoreShape>;

export type SaveResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "conflict" | "invalid" | "internal"; reason: string };

function emptyStore(): Store {
  return { sets: {}, decisions: {}, roles: {} };
}

function readStore(custom?: StorageLike): Store {
  const store = backend(custom);
  if (!store) return emptyStore();
  try {
    const raw = store.getItem(KEY);
    if (!raw) return emptyStore();
    const parsed = StoreShape.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : emptyStore();
  } catch {
    return emptyStore();
  }
}

function writeStore(s: Store, custom?: StorageLike): SaveResult<true> {
  const store = backend(custom);
  if (!store) {
    return { ok: false, code: "internal", reason: "no storage backend" };
  }
  try {
    store.setItem(KEY, JSON.stringify(s));
    return { ok: true, value: true };
  } catch (e) {
    return { ok: false, code: "internal", reason: String(e) };
  }
}

export function getSet(imageId: string, storage?: StorageLike): AnnotationSet | null {
  return readStore(storage).sets[imageId] ?? null;
}

export function listSets(storage?: StorageLike): AnnotationSet[] {
  return Object.values(readStore(storage).sets);
}

export function getDecisions(setId: string, storage?: StorageLike): ReviewDecision[] {
  return readStore(storage).decisions[setId] ?? [];
}

/** Create-or-load the working set for an image (fresh sets start at version 1). */
export function ensureSet(
  imageId: string,
  gtCount: number,
  storage?: StorageLike,
): AnnotationSet {
  void gtCount;
  const store = readStore(storage);
  const existing = store.sets[imageId];
  if (existing) return existing;
  const set: AnnotationSet = {
    image_id: imageId,
    assignee_id: AUTHOR,
    state: "draft",
    version: 1,
    submitted_at: null,
    annotations: [],
  };
  store.sets[imageId] = set;
  writeStore(store, storage);
  return set;
}

/**
 * Save annotations with optimistic concurrency: `expectedVersion` must match
 * the stored version or the write is rejected with `conflict`.
 */
export function saveAnnotations(
  imageId: string,
  annotations: Annotation[],
  expectedVersion: number,
  state?: AnnotationStatus,
  storage?: StorageLike,
): SaveResult<AnnotationSet> {
  const check = z.array(Annotation).safeParse(annotations);
  if (!check.success) {
    return { ok: false, code: "invalid", reason: check.error.message };
  }
  const store = readStore(storage);
  const current = store.sets[imageId];
  if (!current) {
    return { ok: false, code: "invalid", reason: `no set for image ${imageId}` };
  }
  if (current.version !== expectedVersion) {
    return {
      ok: false,
      code: "conflict",
      reason: `version ${expectedVersion} is stale; stored=${current.version}`,
    };
  }
  const next: AnnotationSet = {
    ...current,
    annotations: check.data,
    state: state ?? current.state,
    submitted_at: state === "submitted" ? new Date().toISOString() : current.submitted_at,
    version: current.version + 1,
  };
  store.sets[imageId] = next;
  const w = writeStore(store, storage);
  if (!w.ok) return w;
  return { ok: true, value: next };
}

/** Apply a review decision to a submitted set (state machine enforced). */
export function applyDecision(
  imageId: string,
  decision: "approved" | "rejected",
  reason: string,
  reviewerId: string,
  storage?: StorageLike,
): SaveResult<AnnotationSet> {
  const store = readStore(storage);
  const set = store.sets[imageId];
  if (!set) return { ok: false, code: "invalid", reason: `no set for image ${imageId}` };
  if (set.state !== "submitted") {
    return { ok: false, code: "invalid", reason: `set is ${set.state}, not submitted` };
  }
  const next: AnnotationSet = {
    ...set,
    state: decision,
    annotations: set.annotations.map((a) => ({ ...a, status: decision })),
    version: set.version + 1,
  };
  store.sets[imageId] = next;
  const record: ReviewDecision = {
    annotation_set_id: imageId,
    reviewer_id: reviewerId,
    decision,
    reason,
    decided_at: new Date().toISOString(),
  };
  store.decisions[imageId] = [...(store.decisions[imageId] ?? []), record];
  const w = writeStore(store, storage);
  if (!w.ok) return w;
  return { ok: true, value: next };
}

export function getRole(storage?: StorageLike): "user" | "reviewer" | "admin" {
  const store = backend(storage);
  if (!store) return "user";
  const raw = store.getItem(ROLE_KEY);
  return raw === "reviewer" || raw === "admin" ? raw : "user";
}

export function setRole(role: "user" | "reviewer" | "admin", storage?: StorageLike): void {
  const store = backend(storage);
  if (!store) return;
  store.setItem(ROLE_KEY, role);
}

export const demoAuthorId = AUTHOR;

/** Clear all M5 local state (demo reset). */
export function resetAll(storage?: StorageLike): void {
  const store = backend(storage);
  if (!store) return;
  store.removeItem(KEY);
}
