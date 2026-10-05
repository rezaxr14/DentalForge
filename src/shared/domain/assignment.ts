function assignmentWeight(exact: boolean, fdi: boolean, c: number): number {
  return (exact ? 1000 : fdi ? 100 : 0) + c;
}

/** Max-weight one-to-one assignment; brute force (exact) for small sizes. */
export function bestAssignment(
  closeness: number[][], fdiMatch: boolean[][], exactMatch: boolean[][],
  nGt: number, nPred: number,
): [number, number][] {
  const n = Math.min(nGt, nPred);
  if (n > 7) return greedyAssignment(closeness, fdiMatch, exactMatch, nGt, nPred);
  const smallIsGt = nGt <= nPred;
  const small = smallIsGt ? nGt : nPred;
  const large = smallIsGt ? nPred : nGt;
  const w = (a: number, b: number): number => {
    const i = smallIsGt ? a : b; const j = smallIsGt ? b : a;
    return assignmentWeight(Boolean(exactMatch[i]?.[j]), Boolean(fdiMatch[i]?.[j]), closeness[i]?.[j] ?? 0);
  };
  let bestScore = -Infinity;
  let best: [number, number][] = [];
  const used = new Array<boolean>(large).fill(false);
  const current: [number, number][] = [];
  const rec = (k: number, score: number): void => {
    if (k === small) {
      if (score > bestScore) {
        bestScore = score;
        best = current.map(([a, b]) => [a, b] as [number, number]);
      }
      return;
    }
    for (let l = 0; l < large; l++) {
      if (used[l]) continue;
      used[l] = true;
      current.push(smallIsGt ? [k, l] : [l, k]);
      rec(k + 1, score + w(k, l));
      current.pop();
      used[l] = false;
    }
  };
  rec(0, 0);
  return best;
}

/** Greedy fallback for large cases (same priority order as Python fallback). */
export function greedyAssignment(
  closeness: number[][], fdiMatch: boolean[][], exactMatch: boolean[][],
  nGt: number, nPred: number,
): [number, number][] {
  const usedP = new Set<number>(); const usedG = new Set<number>();
  const out: [number, number][] = [];
  const order: [number, number, number][] = [];
  for (let i = 0; i < nGt; i++)
    for (let j = 0; j < nPred; j++)
      order.push([
        assignmentWeight(Boolean(exactMatch[i]?.[j]), Boolean(fdiMatch[i]?.[j]), closeness[i]?.[j] ?? 0), i, j,
      ]);
  order.sort((a, b) => b[0] - a[0]);
  for (const [, i, j] of order) {
    if (usedG.has(i) || usedP.has(j)) continue;
    usedG.add(i); usedP.add(j); out.push([i, j]);
  }
  return out;
}
