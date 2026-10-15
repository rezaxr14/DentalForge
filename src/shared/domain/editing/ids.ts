/**
 * Next id suffix that cannot collide with an existing annotation. Imported boxes are named `pred_<image>_<n>` and
 * drawn ones `ann_<time>_<n>`; using `annotations.length` as `n` reuses a suffix after any delete, which gave two boxes
 * the same id (and would make a batch import silently skip one).
 */
export function nextIndex(items: readonly { id: string }[]): number {
  let max = -1;
  for (const { id } of items) {
    const m = /_(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return Math.max(max + 1, items.length);
}
