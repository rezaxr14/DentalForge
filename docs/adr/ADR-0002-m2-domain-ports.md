# ADR-0002: M2 domain ports and parity approach

**Status:** accepted
**Date:** 2026-10-05

## Ported (TS, parity-tested vs real Python goldens in fixtures/goldens/m2_goldens.json)

- `normalize_dental_diagnosis` — exact on 18 variants (incl. `Impacted Tooth`,
  `carious lesion`, Tufts `*Lesion` fallbacks -> `Periapical Lesion`).
- `compute_finding_closeness` — exact to 1e-9 on 6 pairs.
- `match_multi_findings` — exact (F1, closeness, tp counts); brute-force
  max-weight assignment replaces scipy Hungarian (identical weight rule
  1000*exact + 100*fdi + closeness), exact for case sizes here; greedy
  fallback beyond 7x7.
- `expected_calibration_error` (+ `compute_ece` alias) — exact.
- `reward_format/tool_validity/efficiency/accuracy/combine_reward` — exact on
  3 trajectories. CAUGHT by parity: Python `_is_valid_final_answer([])` is
  False (empty list invalid) — initial TS returned 1.0 via a dict-first check.
- `dentexRowToFdi` (single +1 site), FDI <-> parts, YOLO class idx <-> FDI
  (all 32 round-trip).

## Statistical, not exact

- `bootstrap_metric_ci` / `bootstrap_paired_diff_ci`: point estimates exact;
  CIs within 0.06 of Python (different PRNG: mulberry32 vs numpy default_rng).
  Documented in code; acceptable for Eval Hub CIs (recomputed live anyway).

## Deferred

- `extract_predicted_findings`, `compute_evaluation_metrics`,
  `compute_diagnostic_metrics` (need sklearn ports + own golden sets).
