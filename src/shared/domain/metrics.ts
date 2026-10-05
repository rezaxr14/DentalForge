/**
 * M2 port of dental_agent/evaluation/metrics.py (pure functions).
 * Parity enforced by tests/m2-parity.test.ts vs fixtures/goldens/m2_goldens.json.
 */

export interface LooseFinding {
  quadrant?: unknown;
  tooth_position?: unknown;
  diagnosis?: unknown;
  confidence?: unknown;
  [key: string]: unknown;
}

/** Port of normalize_dental_diagnosis. */
export function normalizeDentalDiagnosis(val: unknown): string {
  if (val === null || val === undefined) return "Unknown";
  const s = String(val).trim().toLowerCase();
  if (
    s.includes("deep") &&
    (s.includes("caries") || s.includes("decay") || s.includes("carious") || s.includes("cavity"))
  ) {
    return "Deep Caries";
  }
  if (
    s.includes("periapical") ||
    s.includes("apical") ||
    s.includes("abscess") ||
    s.includes("granuloma") ||
    s.includes("cyst")
  ) {
    return "Periapical Lesion";
  }
  if (s.includes("radiolucen") && !(s.includes("caries") || s.includes("decay"))) {
    return "Periapical Lesion";
  }
  if (
    s.includes("caries") ||
    s.includes("carious") ||
    s.includes("decay") ||
    s.includes("cavity") ||
    s.includes("demineraliz")
  ) {
    return "Caries";
  }
  if (s.includes("impact") || s.includes("unerupted") || s.includes("embedded")) {
    return "Impacted";
  }
  if (s.includes("lesion")) {
    return "Periapical Lesion";
  }
  return String(val).trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Port of compute_finding_closeness -> [composite, spatial, diagSim]. */
export function computeFindingCloseness(
  gt: LooseFinding,
  pred: LooseFinding,
): [composite: number, spatial: number, diagSim: number] {
  const gtQ = gt.quadrant as number | null;
  const gtPos = gt.tooth_position as number | null;
  const gtDiag = normalizeDentalDiagnosis(gt.diagnosis);
  const pQ = pred.quadrant as number | null;
  const pPos = pred.tooth_position as number | null;
  const pDiag = normalizeDentalDiagnosis(pred.diagnosis);
  let spatial = 0;
  if (gtQ != null && gtPos != null && pQ != null && pPos != null) {
    if (gtQ === pQ && gtPos === pPos) {
      spatial = 1.0;
    } else if (gtQ === pQ && Math.abs(gtPos - pPos) === 1) {
      spatial = 0.75;
    } else if (
      gtPos === 1 &&
      pPos === 1 &&
      ((gtQ === 1 && pQ === 2) ||
        (gtQ === 2 && pQ === 1) ||
        (gtQ === 3 && pQ === 4) ||
        (gtQ === 4 && pQ === 3))
    ) {
      spatial = 0.75;
    } else if (gtQ === pQ) {
      spatial = 0.4;
    } else if (
      ((gtQ === 1 || gtQ === 2) && (pQ === 1 || pQ === 2)) ||
      ((gtQ === 3 || gtQ === 4) && (pQ === 3 || pQ === 4))
    ) {
      if (gtPos === pPos) spatial = 0.3;
    } else {
      spatial = 0.0;
    }
  }
  let diagSim = 0;
  if (gtDiag && pDiag) {
    if (gtDiag === pDiag) {
      diagSim = 1.0;
    } else if (
      (gtDiag === "Caries" && pDiag === "Deep Caries") ||
      (gtDiag === "Deep Caries" && pDiag === "Caries")
    ) {
      diagSim = 0.75;
    } else if (
      ((gtDiag === "Caries" || gtDiag === "Deep Caries") && pDiag === "Periapical Lesion") ||
      ((pDiag === "Caries" || pDiag === "Deep Caries") && gtDiag === "Periapical Lesion")
    ) {
      diagSim = 0.4;
    } else {
      diagSim = 0.0;
    }
  }
  return [0.5 * spatial + 0.5 * diagSim, spatial, diagSim];
}
