/**
 * FDI (World Dental Federation) helpers — M2 port.
 *
 * RULE (plan §4.2): exactly ONE place converts raw DENTEX 0-index fields to
 * FDI (`dentexRowToFdi`). Tufts rows are already 1-indexed — never convert.
 */

export interface Fdi {
  quadrant: number;
  position: number;
}

/** Parse an FDI int (e.g. 48) into quadrant + position. */
export function fdiToParts(fdi: number): Fdi {
  const quadrant = Math.floor(fdi / 10);
  const position = fdi % 10;
  if (quadrant < 1 || quadrant > 4 || position < 1 || position > 8) {
    throw new RangeError(`invalid FDI number: ${fdi}`);
  }
  return { quadrant, position };
}

/** Combine 1-indexed quadrant + position into an FDI int. */
export function fdiFromParts(quadrant: number, position: number): number {
  if (!Number.isInteger(quadrant) || quadrant < 1 || quadrant > 4) {
    throw new RangeError(`invalid quadrant: ${quadrant}`);
  }
  if (!Number.isInteger(position) || position < 1 || position > 8) {
    throw new RangeError(`invalid position: ${position}`);
  }
  return quadrant * 10 + position;
}

/**
 * THE single DENTEX 0-index conversion: raw `category_id_1` (0–3) and
 * `category_id_2` (0–7) become 1-indexed FDI quadrant/position.
 * Do NOT apply to Tufts rows (double-increment bug).
 */
export function dentexRowToFdi(rawQuadrant0: number, rawPosition0: number): Fdi {
  return { quadrant: rawQuadrant0 + 1, position: rawPosition0 + 1 };
}

/** YOLO class index <-> FDI, 32 classes one per tooth. */
export function fdiToClassIdx(quadrant: number, position: number): number {
  return (quadrant - 1) * 8 + (position - 1);
}

export function classIdxToFdi(classIdx: number): Fdi {
  if (!Number.isInteger(classIdx) || classIdx < 0 || classIdx > 31) {
    throw new RangeError(`invalid class index: ${classIdx}`);
  }
  return { quadrant: Math.floor(classIdx / 8) + 1, position: (classIdx % 8) + 1 };
}

// --- Tool-facing helpers (M4 port of dental_agent/tools/fdi.py) ---

export const QUADRANT_NAMES: Record<number, string> = {
  1: "Maxillary Right (Upper Right)",
  2: "Maxillary Left (Upper Left)",
  3: "Mandibular Left (Lower Left)",
  4: "Mandibular Right (Lower Right)",
};

export const TOOTH_NAMES: Record<number, string> = {
  1: "Central Incisor",
  2: "Lateral Incisor",
  3: "Canine",
  4: "First Premolar",
  5: "Second Premolar",
  6: "First Molar",
  7: "Second Molar",
  8: "Third Molar (Wisdom Tooth)",
};

/** Port of tool_fdi_label: two-digit string ("36") or null if invalid. */
export function fdiLabel(quadrant: number, position: number): string | null {
  if ([1, 2, 3, 4].includes(quadrant) && position >= 1 && position <= 8) {
    return `${quadrant}${position}`;
  }
  return null;
}

/** Port of get_anatomical_name (accepts FDI int or quadrant+position args). */
export function anatomicalName(quadrantOrFdi: number | string, position?: number): string {
  let quadrant: number, pos: number;
  if (position === undefined) {
    const parts = fdiToParts(Number(quadrantOrFdi));
    quadrant = parts.quadrant;
    pos = parts.position;
  } else {
    quadrant = Number(quadrantOrFdi);
    pos = position;
  }
  const qName = QUADRANT_NAMES[quadrant] ?? `Quadrant ${quadrant}`;
  const tName = TOOTH_NAMES[pos] ?? `Tooth ${pos}`;
  const label = fdiLabel(quadrant, pos) ?? "??";
  return `${qName} ${tName} (FDI #${label})`;
}

/** Port of flip_quadrant: swap anatomical left/right under horizontal flip. */
export function flipQuadrant(quadrant: number): number {
  const mapping: Record<number, number> = { 1: 2, 2: 1, 3: 4, 4: 3 };
  const flipped = mapping[quadrant];
  if (flipped === undefined) throw new RangeError(`Invalid quadrant: ${quadrant}`);
  return flipped;
}
