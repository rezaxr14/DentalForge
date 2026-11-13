#!/usr/bin/env node
/**
 * `pnpm perf:editor` - run the opt-in editor timings on any OS.
 *
 * `playwright.config.ts` ignores `perf-*.spec.ts` unless `E2E_PERF` is set, and
 * `VAR=1 command` is shell syntax that does not work in cmd.exe or PowerShell.
 * This wrapper sets the variable and runs the Playwright CLI directly, so the
 * documented command works on Windows, macOS and Linux without extra packages.
 *
 * The spec still needs a database (`E2E_DATABASE_URL`) and a production build
 * (`pnpm build`); it boots `next start` itself. Results go to perf-results/.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const cli = join(process.cwd(), "node_modules", "@playwright", "test", "cli.js");
const run = spawnSync(process.execPath, [cli, "test", "e2e/perf-editor.spec.ts", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, E2E_PERF: "1" },
});
if (run.error) {
  console.error(`perf:editor: could not start Playwright (${run.error.message}). Run \`pnpm install\` first.`);
  process.exit(1);
}
process.exit(run.status ?? 1);
