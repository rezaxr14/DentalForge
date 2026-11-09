/**
 * Browser tests (M8 task E). Run with `pnpm e2e:browser` after `pnpm build`.
 *
 * There is deliberately NO `webServer` block: the degradation matrix needs the
 * production server booted with a different environment per variant (database
 * down, worker off, Redis unreachable, storage failing), so every spec boots
 * its own `next start` through `e2e/support/app.ts` — same idea as
 * `scripts/smoke-degradation.mjs`, but with a real browser.
 *
 * Browser binary: by default Playwright's own Chromium (`pnpm exec playwright
 * install chromium`). Where that download is blocked, point PW_CHROMIUM_PATH
 * at any Chromium / headless-shell binary (and optionally PW_CHROMIUM_ARGS,
 * space-separated, e.g. "--no-sandbox" inside a container).
 */
import { defineConfig } from "@playwright/test";

const executablePath = process.env.PW_CHROMIUM_PATH || undefined;
const args = (process.env.PW_CHROMIUM_ARGS ?? "").split(/\s+/).filter(Boolean);

export default defineConfig({
  testDir: "./e2e",
  // Timing measurements are opt-in (`pnpm perf:editor`): they depend on the machine and must not gate a normal run.
  testIgnore: process.env.E2E_PERF ? [] : ["**/perf-*.spec.ts"],
  // Specs own their servers and databases rows; one worker keeps ports and rows predictable.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  outputDir: "test-results",
  globalSetup: "./e2e/support/global-setup.ts",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { ...(executablePath ? { executablePath } : {}), args },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
