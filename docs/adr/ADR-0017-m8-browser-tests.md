# ADR-0017 — M8 task E: browser tests, and three defects they found

Date: 2026-10-14 · Status: accepted

## Context
Everything before M8-E was proven by unit tests, HTTP smoke and a worker e2e; nothing had run in a browser. Playwright (1.63.0) and axe (`@axe-core/playwright` 4.13.0) were added
(exact pins older than 14 days; 1.64.0 was 6 days old).

## Decisions
1. **Specs boot their own `next start`** with an explicit environment (`e2e/support/app.ts`), no `webServer` block: the degradation matrix needs five shapes (DB down + worker off, DB
   down + worker live, DB up + nothing attached, Redis unreachable, storage failing). The child gets only the variables passed in, so a developer's shell cannot change a variant.
2. **A test fails on** uncaught exceptions, `console.error`, failed same-origin requests, 5xx and error-boundary text. Only two things are ignored, both narrowly: Next's aborted
   `?_rsc=` prefetches, and the aborted body of a request that already received a success response. Nothing else is allow-listed.
3. **`PW_CHROMIUM_PATH`/`PW_CHROMIUM_ARGS`** let a download-blocked environment use any Chromium; the sandbox Chromium is not a dependency.
4. **axe runs on every page in light and dark with WCAG A/AA tags and no exclusions.** It finds only automatable problems; a pass is not an accessibility audit.
5. **Dark-theme palette.** `zinc-500/600` are used only as text colours, so in `.dark` they resolve to `zinc-400` (one rule instead of ~115 `dark:` pairs; explicit `dark:text-*`
   still wins). Hard-coded light surfaces (`bg-white`, `bg-zinc-50/100`, `border-zinc-300`, `text-zinc-700`) gained a `dark:` pair using the theme tokens; light mode is unchanged.
6. **Browser-only state is read after mount.** `useMounted()` (`useSyncExternalStore`, server/hydration snapshot `false`) gates `localStorage` reads in client components.
7. **`isDegradedStore` reads a `degraded` brand, not `instanceof MemoryStore`.** The selector is shared on `globalThis` across route bundles, each of which may hold its own copy of
   the class.

## Defects found (all fixed in this change set)
React #418 on `/labels/queue|review|export` for any returning user; `/status` reporting the database "connected" while `/api/health` said down; dark mode unreadable (muted text 2.56:1,
~90 light-only surfaces).

## Not covered
Windows runs, the SSE client in a browser, visual regression, image licensing.
