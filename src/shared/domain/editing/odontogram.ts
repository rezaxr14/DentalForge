/** Which of the 32 permanent-tooth FDI slots are labeled / in conflict (plan §11.3 odontogram + duplicate warnings). */
import type { Annotation } from "@/shared/contracts/labels";
import { fdiFromParts } from "@/shared/domain/fdi";

export type SlotState = "empty" | "labeled" | "conflict";

export interface Slot {
  quadrant: number;
  position: number;
  fdi: number;
  state: SlotState;
  /** Annotation ids on this slot, in list order. */
  ids: string[];
}

type Labeled = Pick<Annotation, "id" | "fdi_quadrant" | "fdi_position">;

/** Chart order as a clinician reads it: the patient's right is on the viewer's left. */
export const ODONTOGRAM_LAYOUT: { upper: [number, number][]; lower: [number, number][] } = {
  upper: [...[8, 7, 6, 5, 4, 3, 2, 1].map((p): [number, number] => [1, p]), ...[1, 2, 3, 4, 5, 6, 7, 8].map((p): [number, number] => [2, p])],
  lower: [...[8, 7, 6, 5, 4, 3, 2, 1].map((p): [number, number] => [4, p]), ...[1, 2, 3, 4, 5, 6, 7, 8].map((p): [number, number] => [3, p])],
};

export function odontogram(annotations: Labeled[]): { upper: Slot[]; lower: Slot[]; labeled: number; conflicts: number[] } {
  const byFdi = new Map<number, string[]>();
  for (const a of annotations) {
    let fdi: number;
    try {
      fdi = fdiFromParts(a.fdi_quadrant, a.fdi_position);
    } catch {
      continue; // out-of-range labels cannot occupy a slot; the contract rejects them upstream
    }
    byFdi.set(fdi, [...(byFdi.get(fdi) ?? []), a.id]);
  }
  const slot = ([quadrant, position]: [number, number]): Slot => {
    const fdi = fdiFromParts(quadrant, position);
    const ids = byFdi.get(fdi) ?? [];
    return { quadrant, position, fdi, ids, state: ids.length === 0 ? "empty" : ids.length === 1 ? "labeled" : "conflict" };
  };
  const upper = ODONTOGRAM_LAYOUT.upper.map(slot);
  const lower = ODONTOGRAM_LAYOUT.lower.map(slot);
  const all = [...upper, ...lower];
  return {
    upper,
    lower,
    labeled: all.filter((s) => s.state !== "empty").length,
    conflicts: all.filter((s) => s.state === "conflict").map((s) => s.fdi),
  };
}
