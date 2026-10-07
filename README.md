# TraceForge

Research-prototype workbench over real Dental-Agent artifacts (agent traces,
zero-shot evals, YOLO pre-labels, annotations). **Research prototype, not for
clinical use.**

Plan: `TRACEFORGE_IMPLEMENTATION_PLAN.md` (M0–M4 done; M5 in progress).
Decisions: `docs/adr/` (ADR-0001 through ADR-0006).

## Quickstart

```bash
pnpm install
pnpm dev        # http://localhost:3000
```

Quality gates (also run in CI):

```bash
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint
pnpm test        # vitest run
pnpm ci          # all three
pnpm build       # production build (self-hosted Geist, no Google Fonts fetch)
```

## Learn More (TraceForge docs)

To learn more about TraceForge, start with the plan and ADRs:

- [`TRACEFORGE_IMPLEMENTATION_PLAN.md`](./TRACEFORGE_IMPLEMENTATION_PLAN.md) — milestones M0–M13 (M0–M4 done; M5 in progress)
- [`docs/adr/`](./docs/adr/) — ADR-0001 through ADR-0006 (schemas, parity, leak-definition fix)
- Data honesty: directive leak = assistant text matching VLM-DENTAL `LEAK_PATTERNS` (**0 / 5,454**); teacher scaffold in stored user messages is expected setup (5,454 / 5,454) — see ADR-0006.

## Deploy on Vercel

Standard Next.js deploy. Builds are self-hosted (Geist via the `geist`
package, no Google Fonts fetch). `WORKER_MODE` defaults to `off`; never set
`HF_TOKEN` on Vercel (local import scripts only).
