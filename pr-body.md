Implements Phase A of NEXT_STEPS_IMPLEMENTATION_PLAN.md.

**S1. Fix axe regressions (F1)**
- Replaced failing small-text colours (sky-600 4.02:1, emerald-600 3.67:1, amber-600 3.19:1) with 700 shades (5.05–5.85:1)
- Wrapped `/agent` replay list in focusable `role="region"` scroll container
- **Result**: axe 41/41 light+dark; negative control confirms old colours fail

**S2. Merge WP1-3 stack (F2)**
- Renumbered stack ADRs: 0024→0030 (compat), 0025→0031 (backends) — 76 refs in 47 files
- Merged with conflict resolution in 5 files; WP1 versioned adapters are single parse path
- Three `main`-only fixes preserved on adapter path:
  1. YOLO metrics from top-level `mean_*` keys
  2. `no_tools` → 0 tool calls derived from turns
  3. Fixture DataSource excludes non-DENTEX traces

**S3. Correct documents (F3)**
- README: plan status/ADR range updated; unfulfilled claims removed
- ADR-0027/0028 → `proposed`; ADR-0027 size table corrected
- WP11 proof report: removed non-existent `pnpm contract:validate`
- Added `docs/wp0-evidence.md` with sanitized WP0 inventory

**S4. CI gates (F10)**
- Required checks: typecheck, lint, unit, build, smoke, e2e (labels+axe+degradation), e2e:worker, Python WP tests, upstream-compat weekly

**Assets & Licence**
- Committed `public/demo-assets/` (4.8 MB, 84 files) for reproducible Vercel deploys
- Added `LICENSE`: All Rights Reserved (pre-publication) → auto-converts to Apache-2.0 on VLM-DENTAL paper publication
- Added `THIRD_PARTY_NOTICES.md`: DENTEX (CC BY-NC-SA 4.0), YOLO (AGPL-3.0)

**VLM-DENTAL**: Read-only throughout. Clean at fccfd70. Manifest `dirty:true` was transient.

**Verification**: typecheck ✅, lint ✅, test 517 ✅, build ✅, ci ✅, axe 41/41 ✅, smoke 27/27 ✅