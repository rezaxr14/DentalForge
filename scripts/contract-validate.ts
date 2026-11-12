/**
 * `pnpm contract:validate` — one command for both sides of the worker contract.
 *
 *   1. the committed `docs/worker-openapi.json` and `docs/worker-contract.md`
 *      are exactly what the Zod contracts produce (no stale published schema);
 *   2. the Python reference handlers' recorded events and results validate
 *      against that document with `jsonschema` (negative controls included);
 *   3. the same recording validates against the server's Zod schemas
 *      (negative controls included).
 *
 * A schema that drifts from the handlers fails at least one side, so this is
 * not a "the docs parse" check.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildWorkerOpenApi } from "../src/shared/contracts/openapi";
import { renderContractMarkdown } from "../src/shared/contracts/render-docs";

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failures += 1;
}

function run(label: string, command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: process.cwd() });
  check(`${label} (exit ${result.status ?? "spawn error"})`, result.status === 0);
}

console.log("contract:validate");

// ---- 1. the published contract is generated, not hand-edited ----------------
const doc = buildWorkerOpenApi();
const openapiPath = join("docs", "worker-openapi.json");
const markdownPath = join("docs", "worker-contract.md");
const wantOpenapi = JSON.stringify(doc, null, 2) + "\n";
const wantMarkdown = renderContractMarkdown(doc);
const gotOpenapi = readFileSync(openapiPath, "utf8");
const gotMarkdown = readFileSync(markdownPath, "utf8");
check(`${openapiPath} matches the Zod contracts`, gotOpenapi === wantOpenapi);
check(`${markdownPath} matches the Zod contracts`, gotMarkdown === wantMarkdown);

// ---- 2. Python handlers -> docs/worker-openapi.json (jsonschema) ------------
run(
  "python: recorded events/results against the OpenAPI document",
  process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3"),
  ["-m", "pytest", "tests/python/test_wp3_acceptance.py", "-q"],
);

// ---- 3. the same recording -> the server's Zod schemas ----------------------
run(
  "zod: recorded events/results against the server schemas",
  process.execPath,
  [join("node_modules", "vitest", "vitest.mjs"), "run", "tests/m8-wp3-acceptance.test.ts"],
);

console.log(
  failures === 0 ? "\ncontract:validate: all checks passed" : `\ncontract:validate: ${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
