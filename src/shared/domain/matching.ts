import { computeFindingCloseness, normalizeDentalDiagnosis } from "./metrics";
import { bestAssignment } from "./assignment";
import type { LooseFinding } from "./metrics";

export interface MatchedPairOut {
  gt: LooseFinding;
  pred: LooseFinding;
  fdi_match: boolean;
  exact_match: boolean;
  closeness: number;
  spatial: number;
  diag_sim: number;
}

export interface MatchResult {
  gt_count: number;
  pred_count: number;
  fdi_tp: number;
  fdi_fp: number;
  fdi_fn: number;
  fdi_precision: number;
  fdi_recall: number;
  fdi_f1: number;
  exact_tp: number;
  exact_fp: number;
  exact_fn: number;
  exact_precision: number;
  exact_recall: number;
  exact_f1: number;
  closeness_score: number;
  recall_closeness: number;
  precision_closeness: number;
  spatial_proximity: number;
  diagnostic_similarity: number;
  matched_pairs: MatchedPairOut[];
}

export function emptyMatch(nGt: number, nPred: number, v: number): MatchResult {
  return {
    gt_count: nGt, pred_count: nPred,
    fdi_tp: 0, fdi_fp: nPred, fdi_fn: nGt,
    fdi_precision: v, fdi_recall: v, fdi_f1: v,
    exact_tp: 0, exact_fp: nPred, exact_fn: nGt,
    exact_precision: v, exact_recall: v, exact_f1: v,
    closeness_score: v, recall_closeness: v, precision_closeness: v,
    spatial_proximity: v, diagnostic_similarity: v,
    matched_pairs: [],
  };
}

export function pairWeight(exact: boolean, fdi: boolean, c: number): number {
  return (exact ? 1000 : fdi ? 100 : 0) + c;
}


/**
 * Port of match_multi_findings. Python uses scipy Hungarian; this port uses
 * brute-force max-weight assignment with the identical weight rule — exact
 * for case sizes here (a handful of findings). Greedy fallback beyond 7x7.
 */
export function matchMultiFindings(gtList: LooseFinding[], predList: LooseFinding[]): MatchResult {
  const nGt = gtList.length;
  const nPred = predList.length;
  if (nGt === 0 && nPred === 0) return emptyMatch(0, 0, 1.0);
  if (nGt === 0 || nPred === 0) return emptyMatch(nGt, nPred, 0.0);
  const closeness: number[][] = [];
  const spatial: number[][] = [];
  const diag: number[][] = [];
  const fdiMatch: boolean[][] = [];
  const exactMatch: boolean[][] = [];
  for (let i = 0; i < nGt; i++) {
    const cr: number[] = []; const sr: number[] = []; const dr: number[] = [];
    const fr: boolean[] = []; const er: boolean[] = [];
    for (let j = 0; j < nPred; j++) {
      const gt = gtList[i] as LooseFinding;
      const pred = predList[j] as LooseFinding;
      const [c, s, d] = computeFindingCloseness(gt, pred);
      cr.push(c); sr.push(s); dr.push(d);
      const fm =
        gt.quadrant != null && gt.tooth_position != null &&
        gt.quadrant === pred.quadrant && gt.tooth_position === pred.tooth_position;
      const em = fm && normalizeDentalDiagnosis(gt.diagnosis) === normalizeDentalDiagnosis(pred.diagnosis);
      fr.push(fm); er.push(em);
    }
    closeness.push(cr); spatial.push(sr); diag.push(dr);
    fdiMatch.push(fr); exactMatch.push(er);
  }
  const pairs = bestAssignment(closeness, fdiMatch, exactMatch, nGt, nPred);
  let fdiTp = 0; let exactTp = 0;
  const matchedPairs: MatchedPairOut[] = [];
  for (const [i, j] of pairs) {
    if (fdiMatch[i]?.[j]) fdiTp++;
    if (exactMatch[i]?.[j]) exactTp++;
    matchedPairs.push({
      gt: gtList[i] as LooseFinding, pred: predList[j] as LooseFinding,
      fdi_match: Boolean(fdiMatch[i]?.[j]), exact_match: Boolean(exactMatch[i]?.[j]),
      closeness: closeness[i]?.[j] ?? 0, spatial: spatial[i]?.[j] ?? 0,
      diag_sim: diag[i]?.[j] ?? 0,
    });
  }
  const fdiP = nPred > 0 ? fdiTp / nPred : 0;
  const fdiR = nGt > 0 ? fdiTp / nGt : 0;
  const exactP = nPred > 0 ? exactTp / nPred : 0;
  const exactR = nGt > 0 ? exactTp / nGt : 0;
  let recallC = 0; let recallS = 0; let recallD = 0;
  for (let i = 0; i < nGt; i++) {
    let best = 0; let bs = 0; let bd = 0;
    for (let j = 0; j < nPred; j++) {
      const c = closeness[i]?.[j] ?? 0;
      if (c > best) { best = c; bs = spatial[i]?.[j] ?? 0; bd = diag[i]?.[j] ?? 0; }
    }
    recallC += best; recallS += bs; recallD += bd;
  }
  recallC /= nGt; recallS /= nGt; recallD /= nGt;
  let precC = 0;
  for (let j = 0; j < nPred; j++) {
    let best = 0;
    for (let i = 0; i < nGt; i++) {
      const c = closeness[i]?.[j] ?? 0;
      if (c > best) best = c;
    }
    precC += best;
  }
  precC /= nPred;
  const balanced = recallC + precC > 0 ? (2 * recallC * precC) / (recallC + precC) : 0;
  return {
    gt_count: nGt, pred_count: nPred,
    fdi_tp: fdiTp, fdi_fp: nPred - fdiTp, fdi_fn: nGt - fdiTp,
    fdi_precision: fdiP, fdi_recall: fdiR,
    fdi_f1: fdiP + fdiR > 0 ? (2 * fdiP * fdiR) / (fdiP + fdiR) : 0,
    exact_tp: exactTp, exact_fp: nPred - exactTp, exact_fn: nGt - exactTp,
    exact_precision: exactP, exact_recall: exactR,
    exact_f1: exactP + exactR > 0 ? (2 * exactP * exactR) / (exactP + exactR) : 0,
    closeness_score: balanced, recall_closeness: recallC, precision_closeness: precC,
    spatial_proximity: recallS, diagnostic_similarity: recallD,
    matched_pairs: matchedPairs,
  };
}
