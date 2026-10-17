"use client";

import type { Annotation } from "@/shared/contracts/labels";
import { PATHOLOGY_LABELS } from "@/shared/contracts/labels";
import type { EditPatch } from "@/shared/domain/editing";

const cell = "border-b border-zinc-100 px-2 py-1 dark:border-border";
const select = "rounded border border-zinc-300 bg-white px-1 py-0.5 text-xs dark:border-border dark:bg-card";

/**
 * The same boxes as a table: everything the canvas can do for labels is reachable by keyboard and screen
 * reader here (plan §11.3 "accessible table view"). Edits go through the same history as the canvas.
 */
export function BoxTable({
  annotations,
  selectedId,
  onSelect,
  onPatch,
  onDelete,
  readOnly = false,
}: {
  annotations: Annotation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPatch: (id: string, patch: EditPatch) => void;
  onDelete: (id: string) => void;
  /** The set cannot be edited (not a draft, read-only role, or not connected yet): selecting still works, changing does not. */
  readOnly?: boolean;
}) {
  return (
    <section aria-labelledby="boxes-h" className="mt-4 rounded border border-zinc-200 p-3 dark:border-border">
      <h2 id="boxes-h" className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        Boxes as a table
      </h2>
      {annotations.length === 0 ? (
        <p className="mt-2 text-xs text-zinc-500">No boxes yet. Draw one on the image, or use Suggest boxes.</p>
      ) : (
        /* `relative`: the table's sr-only cells are absolutely positioned and would otherwise escape this scroller and widen the whole page. */
        <div className="relative mt-2 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Annotation boxes. Change quadrant, position or pathology in the row.</caption>
            <thead className="text-zinc-500">
              <tr>
                <th scope="col" className={cell}>Box</th>
                <th scope="col" className={cell}>Quadrant</th>
                <th scope="col" className={cell}>Position</th>
                <th scope="col" className={cell}>Pathology</th>
                <th scope="col" className={cell}>Source</th>
                <th scope="col" className={cell}>x, y, w, h</th>
                <th scope="col" className={cell}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {annotations.map((a, i) => {
                const n = i + 1;
                const on = a.id === selectedId;
                return (
                  <tr key={a.id} aria-current={on ? "true" : undefined} className={on ? "bg-amber-50 dark:bg-accent" : undefined}>
                    <th scope="row" className={`${cell} font-normal`}>
                      <button
                        type="button"
                        onClick={() => onSelect(a.id)}
                        aria-label={`Select box ${n}`}
                        className="rounded border border-zinc-300 px-2 py-0.5 font-mono dark:border-border"
                      >
                        {n}
                      </button>
                    </th>
                    <td className={cell}>
                      <select
                        aria-label={`Quadrant for box ${n}`}
                        className={`${select} disabled:opacity-50`}
                        disabled={readOnly}
                        value={a.fdi_quadrant}
                        onChange={(e) => onPatch(a.id, { fdi_quadrant: Number(e.target.value) })}
                      >
                        {[1, 2, 3, 4].map((q) => (
                          <option key={q} value={q}>{q}</option>
                        ))}
                      </select>
                    </td>
                    <td className={cell}>
                      <select
                        aria-label={`Position for box ${n}`}
                        className={`${select} disabled:opacity-50`}
                        disabled={readOnly}
                        value={a.fdi_position}
                        onChange={(e) => onPatch(a.id, { fdi_position: Number(e.target.value) })}
                      >
                        {[1, 2, 3, 4, 5, 6, 7, 8].map((p) => (
                          <option key={p} value={p}>{p}</option>
                        ))}
                      </select>
                    </td>
                    <td className={cell}>
                      <select
                        aria-label={`Pathology for box ${n}`}
                        className={`${select} disabled:opacity-50`}
                        disabled={readOnly}
                        value={a.pathology}
                        onChange={(e) => onPatch(a.id, { pathology: e.target.value as Annotation["pathology"] })}
                      >
                        {PATHOLOGY_LABELS.map((p) => (
                          <option key={p} value={p}>{p}</option>
                        ))}
                      </select>
                    </td>
                    <td className={cell}>
                      {a.source}
                      {a.confidence != null ? ` ${a.confidence.toFixed(2)}` : ""}
                    </td>
                    <td className={`${cell} font-mono`}>{a.bbox.map((v) => Math.round(v)).join(", ")}</td>
                    <td className={cell}>
                      <button
                        type="button"
                        onClick={() => onDelete(a.id)}
                        aria-label={`Delete box ${n}`}
                        disabled={readOnly}
                        className="rounded border border-red-300 px-2 py-0.5 text-red-700 disabled:opacity-40 dark:text-red-300"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
