"use client";

import { memo, useEffect, useRef, useState } from "react";
import type { Annotation } from "@/shared/contracts/labels";
import { PATHOLOGY_LABELS } from "@/shared/contracts/labels";
import type { EditPatch } from "@/shared/domain/editing";

const cell = "border-b border-zinc-100 px-2 py-1 dark:border-border";
const select = "rounded border border-zinc-300 bg-white px-1 py-0.5 text-xs dark:border-border dark:bg-card";

// Windowing (ADR-0021): above VIRTUAL_FROM boxes only the rows in view (plus a margin) exist in the DOM. 500 rows are ~12k
// nodes, and changing one cell makes the browser lay out the whole table (38 ms per keypress measured); a window of ~20
// rows does not. Rows have a fixed height so spacer rows can stand in for the rest and the scroll bar stays honest.
const VIRTUAL_FROM = 40;
const ROW_H = 44;
const VIEW_ROWS = 10;
const OVERSCAN = 5;
const HEADER_H = 36;
const COLS = ["4rem", "6rem", "6rem", "11rem", "6rem", "11rem", "5rem"];

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
  const virtual = annotations.length > VIRTUAL_FROM;
  const [scrollTop, setScrollTop] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const latest = useRef(annotations);
  useEffect(() => {
    latest.current = annotations;
  });
  // A box selected on the image or in the odontogram may have its row outside the window: bring it into view.
  useEffect(() => {
    const el = scroller.current;
    if (!virtual || !selectedId || !el) return;
    const i = latest.current.findIndex((a) => a.id === selectedId);
    if (i < 0) return;
    const top = i * ROW_H;
    const viewH = el.clientHeight - HEADER_H;
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + viewH) el.scrollTop = Math.max(0, top - viewH / 2 + ROW_H / 2);
  }, [selectedId, virtual]);
  const start = virtual ? Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN) : 0;
  const end = virtual ? Math.min(annotations.length, Math.ceil((scrollTop + VIEW_ROWS * ROW_H) / ROW_H) + OVERSCAN) : annotations.length;
  const spacer = (rows: number, key: string) =>
    rows > 0 ? (
      <tr key={key} aria-hidden="true" style={{ height: rows * ROW_H }}>
        <td colSpan={7} className="p-0" />
      </tr>
    ) : null;
  return (
    <section aria-labelledby="boxes-h" className="mt-4 rounded border border-zinc-200 p-3 dark:border-border">
      <h2 id="boxes-h" className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        Boxes as a table
      </h2>
      {annotations.length === 0 ? (
        <p className="mt-2 text-xs text-zinc-500">No boxes yet. Draw one on the image, or use Suggest boxes.</p>
      ) : (
        /* `relative`: the table's sr-only cells are absolutely positioned and would otherwise escape this scroller and widen the whole page. */
        <div
          ref={scroller}
          className={`relative mt-2 ${virtual ? "overflow-auto" : "overflow-x-auto"}`}
          style={virtual ? { maxHeight: VIEW_ROWS * ROW_H + HEADER_H } : undefined}
          onScroll={virtual ? (e) => setScrollTop(e.currentTarget.scrollTop) : undefined}
        >
          <table
            className="w-full text-left text-xs"
            style={virtual ? { tableLayout: "fixed", minWidth: "49rem" } : undefined}
            aria-rowcount={virtual ? annotations.length + 1 : undefined}
          >
            {virtual && (
              <colgroup>
                {COLS.map((w, i) => (
                  <col key={i} style={{ width: w }} />
                ))}
              </colgroup>
            )}
            <caption className="sr-only">Annotation boxes. Change quadrant, position or pathology in the row.</caption>
            <thead className={`text-zinc-500 ${virtual ? "sticky top-0 z-10 bg-white dark:bg-card" : ""}`}>
              <tr aria-rowindex={virtual ? 1 : undefined}>
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
              {spacer(start, "top")}
              {annotations.slice(start, end).map((a, k) => (
                <BoxRow key={a.id} a={a} n={start + k + 1} on={a.id === selectedId} readOnly={readOnly} onSelect={onSelect} onPatch={onPatch} onDelete={onDelete} windowed={virtual} />
              ))}
              {spacer(annotations.length - end, "bottom")}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** One row, memoised: selecting a box or editing another one does not render the other 499 rows. */
const BoxRow = memo(function BoxRow({
  a,
  n,
  on,
  readOnly,
  onSelect,
  onPatch,
  onDelete,
  windowed,
}: {
  a: Annotation;
  n: number;
  on: boolean;
  readOnly: boolean;
  windowed: boolean;
  onSelect: (id: string) => void;
  onPatch: (id: string, patch: EditPatch) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <tr
      aria-current={on ? "true" : undefined}
      aria-rowindex={windowed ? n + 1 : undefined}
      className={on ? "bg-amber-50 dark:bg-accent" : undefined}
      style={windowed ? { height: ROW_H } : undefined}
    >
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
});
