/**
 * Event-sourced edit history for one annotation set (plan §11.3 "History").
 *
 * The present state is `annotations`; every change is a Command that carries enough to be applied AND inverted
 * without looking anywhere else (before/after values, the removed annotation, the insert index), so undo/redo is
 * exact and the stack can later be shipped to the server as ops. Pure: no React, no DOM, no clock, no randomness.
 *
 * Drag coalescing: consecutive `update`s of the same box that share a `coalesceKey` (one pointer gesture) merge
 * into ONE undo step; a gesture that ends where it started leaves no step at all.
 */
import type { Annotation } from "@/shared/contracts/labels";

export type AnnotationPatch = Partial<Pick<Annotation, "bbox" | "fdi_quadrant" | "fdi_position" | "pathology" | "status">>;

export type Command =
  | { type: "create"; annotation: Annotation; index: number }
  | { type: "delete"; annotation: Annotation; index: number }
  | { type: "update"; id: string; before: AnnotationPatch; after: AnnotationPatch }
  /** A label edit (FDI / pathology): same shape as update, kept distinct because ops are shipped to the server by kind. */
  | { type: "setLabel"; id: string; before: AnnotationPatch; after: AnnotationPatch }
  | { type: "batch"; label: string; commands: Command[] };

export interface Entry {
  command: Command;
  coalesceKey?: string;
}

export interface History {
  present: Annotation[];
  past: Entry[];
  future: Entry[];
}

export function createHistory(initial: Annotation[] = []): History {
  return { present: initial, past: [], future: [] };
}

/** Replace the present state and forget history (hydration from the store, a review decision). */
export function reset(_h: History, annotations: Annotation[]): History {
  return createHistory(annotations);
}

export const canUndo = (h: History): boolean => h.past.length > 0;
export const canRedo = (h: History): boolean => h.future.length > 0;

// ---------------------------------------------------------------- apply / invert

function applyPatch(a: Annotation, patch: AnnotationPatch): Annotation {
  return { ...a, ...patch } as Annotation;
}

/** Apply a command to an annotation list. Unknown ids and duplicate creates are no-ops (never throw mid-gesture). */
export function apply(list: Annotation[], c: Command): Annotation[] {
  switch (c.type) {
    case "create": {
      if (list.some((a) => a.id === c.annotation.id)) return list;
      const next = list.slice();
      next.splice(Math.min(Math.max(c.index, 0), next.length), 0, c.annotation);
      return next;
    }
    case "delete":
      return list.some((a) => a.id === c.annotation.id) ? list.filter((a) => a.id !== c.annotation.id) : list;
    case "update":
    case "setLabel":
      return list.some((a) => a.id === c.id) ? list.map((a) => (a.id === c.id ? applyPatch(a, c.after) : a)) : list;
    case "batch":
      return c.commands.reduce(apply, list);
  }
}

export function invert(c: Command): Command {
  switch (c.type) {
    case "create":
      return { type: "delete", annotation: c.annotation, index: c.index };
    case "delete":
      return { type: "create", annotation: c.annotation, index: c.index };
    case "update":
    case "setLabel":
      return { ...c, before: c.after, after: c.before };
    case "batch":
      return { type: "batch", label: c.label, commands: c.commands.slice().reverse().map(invert) };
  }
}

// ---------------------------------------------------------------- recording

function record(h: History, command: Command, coalesceKey?: string): History {
  const present = apply(h.present, command);
  if (present === h.present) return h; // nothing changed: no step, redo stack untouched

  const last = h.past[h.past.length - 1];
  if (
    coalesceKey !== undefined &&
    last?.coalesceKey === coalesceKey &&
    last.command.type === "update" &&
    command.type === "update" &&
    last.command.id === command.id
  ) {
    const merged: Command = { type: "update", id: command.id, before: last.command.before, after: command.after };
    const back = h.past.slice(0, -1);
    // The gesture returned to where it started: drop the step instead of leaving an empty undo.
    if (sameValues(merged.before, merged.after)) return { present, past: back, future: [] };
    return { present, past: [...back, { command: merged, coalesceKey }], future: [] };
  }
  return { present, past: [...h.past, { command, coalesceKey }], future: [] };
}

function sameValues(a: AnnotationPatch, b: AnnotationPatch): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof AnnotationPatch>;
  for (const k of keys) {
    const x = a[k];
    const y = b[k];
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length || x.some((v, i) => v !== y[i])) return false;
    } else if (x !== y) return false;
  }
  return true;
}

/** The `before` half of a patch: current values of exactly the keys being changed. */
function beforeOf(a: Annotation, patch: AnnotationPatch): AnnotationPatch {
  const before: Record<string, unknown> = {};
  for (const k of Object.keys(patch) as (keyof AnnotationPatch)[]) before[k] = a[k];
  return before as AnnotationPatch;
}

const isLabelPatch = (p: AnnotationPatch): boolean =>
  ("fdi_quadrant" in p || "fdi_position" in p || "pathology" in p) && !("bbox" in p);

export function create(h: History, annotation: Annotation): History {
  return record(h, { type: "create", annotation, index: h.present.length });
}

export function remove(h: History, id: string): History {
  const index = h.present.findIndex((a) => a.id === id);
  if (index < 0) return h;
  return record(h, { type: "delete", annotation: h.present[index] as Annotation, index });
}

/** Change fields of one box. Label edits become `setLabel`, geometry/other edits `update`. */
export function update(h: History, id: string, patch: AnnotationPatch, opts: { coalesceKey?: string } = {}): History {
  const a = h.present.find((x) => x.id === id);
  if (!a) return h;
  const before = beforeOf(a, patch);
  if (sameValues(before, patch)) return h;
  const type = isLabelPatch(patch) ? "setLabel" : "update";
  return record(h, { type, id, before, after: patch }, opts.coalesceKey);
}

/** Several creates as ONE undo step (importing pre-labels, applying a worker result). */
export function createMany(h: History, annotations: Annotation[], label: string): History {
  const fresh = annotations.filter((a) => !h.present.some((x) => x.id === a.id));
  if (fresh.length === 0) return h;
  const commands: Command[] = fresh.map((annotation, i) => ({ type: "create", annotation, index: h.present.length + i }));
  return record(h, { type: "batch", label, commands });
}

/** Short human description of a step, for screen-reader announcements and tooltips. */
export function describe(c: Command): string {
  switch (c.type) {
    case "create":
      return "draw box";
    case "delete":
      return "delete box";
    case "update":
      return "move or resize box";
    case "setLabel":
      return "change label";
    case "batch":
      return c.label.charAt(0).toLowerCase() + c.label.slice(1);
  }
}

export function undo(h: History): History {
  const entry = h.past[h.past.length - 1];
  if (!entry) return h;
  return { present: apply(h.present, invert(entry.command)), past: h.past.slice(0, -1), future: [entry, ...h.future] };
}

export function redo(h: History): History {
  const entry = h.future[0];
  if (!entry) return h;
  // A redone entry must not coalesce with a later gesture that happens to reuse its key.
  return { present: apply(h.present, entry.command), past: [...h.past, { command: entry.command }], future: h.future.slice(1) };
}
