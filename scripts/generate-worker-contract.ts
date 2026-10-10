/**
 * Regenerates docs/worker-openapi.json and docs/worker-contract.md from the
 * zod contracts. Run with `pnpm contract:docs`; CI fails if the committed
 * files differ from what this produces.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildWorkerOpenApi } from "../src/shared/contracts/openapi";
import { renderContractMarkdown } from "../src/shared/contracts/render-docs";

const doc = buildWorkerOpenApi();
const dir = join(process.cwd(), "docs");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "worker-openapi.json"), JSON.stringify(doc, null, 2) + "\n");
writeFileSync(join(dir, "worker-contract.md"), renderContractMarkdown(doc));
console.log("wrote docs/worker-openapi.json and docs/worker-contract.md");
