/** Deterministic PRNG (mulberry32) for seeded bootstrap reproducibility. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx); const hi = Math.ceil(idx);
  const a = sorted[lo] as number; const b = sorted[hi] as number;
  return a + (b - a) * (idx - lo);
}

/**
 * Port of bootstrap_metric_ci. Uses mulberry32 instead of numpy's default_rng,
 * so exact resample parity with Python is NOT expected — tests check
 * statistical closeness (same point estimate, overlapping CI).
 */
export function bootstrapMetricCi(
  data: number[],
  metricFn: (xs: number[]) => number,
  nBootstrap = 1000,
  ci = 0.95,
  seed = 42,
): [point: number, lo: number, hi: number] {
  const n = data.length;
  if (n === 0) return [0, 0, 0];
  const rand = mulberry32(seed);
  const point = metricFn(data);
  const stats: number[] = [];
  for (let b = 0; b < nBootstrap; b++) {
    const sample: number[] = [];
    for (let i = 0; i < n; i++) sample.push(data[Math.floor(rand() * n)] as number);
    stats.push(metricFn(sample));
  }
  stats.sort((a, b) => a - b);
  const alpha = (1 - ci) / 2;
  return [point, percentile(stats, alpha * 100), percentile(stats, (1 - alpha) * 100)];
}

/** Port of bootstrap_paired_diff_ci (same PRNG caveat as above). */
export function bootstrapPairedDiffCi(
  valuesA: number[],
  valuesB: number[],
  nBoot = 2000,
  ci = 0.95,
  seed = 0,
): [mean: number, ciLowHigh: [number, number]] {
  const diffs = valuesA.map((a, i) => a - (valuesB[i] as number));
  if (diffs.length === 0) return [0, [0, 0]];
  const rand = mulberry32(seed);
  const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const bootMeans: number[] = [];
  for (let b = 0; b < nBoot; b++) {
    let s = 0;
    for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(rand() * diffs.length)] as number;
    bootMeans.push(s / diffs.length);
  }
  bootMeans.sort((a, b) => a - b);
  return [mean, [percentile(bootMeans, ((1 - ci) / 2) * 100), percentile(bootMeans, ((1 + ci) / 2) * 100)]];
}
