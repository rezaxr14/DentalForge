/**
 * The ops that turn the last server-acknowledged boxes into the editor's present boxes (ADR-0020). Pure.
 *
 * Why a diff and not a queue of the commands the editor recorded: history coalesces a drag into ONE entry that is rewritten
 * on every pointer move, so a command queue would either ship every move or have to mirror the history's merge rules. The
 * diff of "acknowledged" against "present" is the same thing, computed once when a request is about to be sent. After a 409
 * the engine adopts the server's boxes and replays THIS list on them with `apply`, which is "rebase without an op log"
 * (ADR-0019 §8) and gives last-writer-wins per field.
 *
 * Only what the server accepts is produced: creates, deletes and `update`/`setLabel` patches of bbox / FDI / pathology.
 * Everything else (status, source, confidence, author, version) moves only through the set's state machine, never here.
 * `opts.authorId` (the viewer) re-authors boxes that are created here but were drawn by someone else (a restored deletion).
 * Two boxes are equal when their float32 values are, because the server stores `real` and returns canonical float32:
 * comparing float64 would re-send every freshly drawn box after each acknowledgement, forever.
 */
import type { Annotation } from "@/shared/contracts/labels";
import type { Command, EditPatch } from "./history";

const f = Math.fround;
const sameBox = (a: Annotation["bbox"], b: Annotation["bbox"]): boolean => a.every((v, i) => f(v) === f(b[i] as number));

/** Order is deletes, then updates, then creates in editor order, so the final array order is the present order. */
export function diffToCommands(
  acked: readonly Annotation[],
  present: readonly Annotation[],
  opts: { authorId?: string } = {},
): Command[] {
  const before = new Map(acked.map((a, i) => [a.id, { a, i }]));
  const now = new Set(present.map((a) => a.id));
  const ops: Command[] = [];

  for (const [id, { a, i }] of before) if (!now.has(id)) ops.push({ type: "delete", annotation: a, index: i });

  for (const p of present) {
    const old = before.get(p.id)?.a;
    if (!old) continue;
    const prev: EditPatch = {};
    const next: EditPatch = {};
    if (!sameBox(old.bbox, p.bbox)) {
      prev.bbox = old.bbox;
      next.bbox = p.bbox;
    }
    if (old.fdi_quadrant !== p.fdi_quadrant) {
      prev.fdi_quadrant = old.fdi_quadrant;
      next.fdi_quadrant = p.fdi_quadrant;
    }
    if (old.fdi_position !== p.fdi_position) {
      prev.fdi_position = old.fdi_position;
      next.fdi_position = p.fdi_position;
    }
    if (old.pathology !== p.pathology) {
      prev.pathology = old.pathology;
      next.pathology = p.pathology;
    }
    if (Object.keys(next).length === 0) continue;
    ops.push({ type: "bbox" in next ? "update" : "setLabel", id: p.id, before: prev, after: next });
  }

  present.forEach((p, index) => {
    if (before.has(p.id)) return;
    // Undoing the deletion of a box someone else drew brings it back with THEIR author, which the server refuses for a
    // create. The person restoring it is the one drawing it again, so it is re-authored to them (ADR-0020).
    const annotation = opts.authorId === undefined ? p : { ...p, author_id: opts.authorId };
    ops.push({ type: "create", annotation, index });
  });
  return ops;
}
