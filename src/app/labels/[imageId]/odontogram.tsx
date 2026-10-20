"use client";

import { memo } from "react";
import { odontogram, type Slot } from "@/shared/domain/editing";
import type { Annotation } from "@/shared/contracts/labels";

const MARK: Record<Slot["state"], string> = { empty: "·", labeled: "●", conflict: "!" };
const TONE: Record<Slot["state"], string> = {
  empty: "border-zinc-200 text-zinc-400 dark:border-border",
  labeled: "border-emerald-600 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  conflict: "border-red-600 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200",
};

/**
 * FDI chart of the 32 permanent teeth. State is shown by a mark and text, never by colour alone:
 * ● labeled, ! more than one box on the same tooth, · empty. Clicking a slot selects its box (and cycles
 * through the boxes when there is a conflict).
 */
export const Odontogram = memo(function Odontogram({
  annotations,
  selectedId,
  onSelect,
}: {
  annotations: Pick<Annotation, "id" | "fdi_quadrant" | "fdi_position">[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const o = odontogram(annotations);

  const pick = (s: Slot): void => {
    const at = s.ids.indexOf(selectedId ?? "");
    const next = s.ids[at >= 0 ? (at + 1) % s.ids.length : 0];
    if (next) onSelect(next);
  };

  const row = (slots: Slot[], label: string): React.ReactNode => (
    <div role="group" aria-label={label} className="grid grid-cols-[repeat(8,minmax(0,1fr))_0.75rem_repeat(8,minmax(0,1fr))] gap-1">
      {slots.slice(0, 8).map(cell)}
      <span aria-hidden="true" className="mx-auto w-px self-stretch bg-zinc-300 dark:bg-border" />
      {slots.slice(8).map(cell)}
    </div>
  );

  const cell = (s: Slot): React.ReactNode => {
    const here = selectedId !== null && s.ids.includes(selectedId);
    return (
      <button
        key={s.fdi}
        type="button"
        disabled={s.state === "empty"}
        onClick={() => pick(s)}
        aria-pressed={here}
        aria-label={`Tooth ${s.fdi}: ${s.state === "empty" ? "no box" : s.state === "labeled" ? "1 box" : `${s.ids.length} boxes, conflict`}`}
        className={`flex h-9 flex-col items-center justify-center rounded border text-[11px] leading-none disabled:cursor-default ${TONE[s.state]} ${
          here ? "ring-2 ring-zinc-900 dark:ring-zinc-100" : ""
        }`}
      >
        <span className="font-mono">{s.fdi}</span>
        <span aria-hidden="true">{MARK[s.state]}</span>
      </button>
    );
  };

  return (
    <section aria-labelledby="odontogram-h" className="mt-4 rounded border border-zinc-200 p-3 dark:border-border">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="odontogram-h" className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Odontogram
        </h2>
        <p className="text-xs text-zinc-600" role="status">
          {o.labeled}/32 teeth have a box
          {o.conflicts.length > 0 && (
            <strong className="ms-2 text-red-700 dark:text-red-300">
              Conflict: more than one box on {o.conflicts.join(", ")}
            </strong>
          )}
        </p>
      </div>
      <div className="mt-2 space-y-1">
        {row(o.upper, "Upper teeth")}
        {row(o.lower, "Lower teeth")}
      </div>
      <p className="mt-2 text-[11px] text-zinc-500">● one box · ! several boxes on one tooth · · none. Right of the patient is on the left.</p>
    </section>
  );
});
