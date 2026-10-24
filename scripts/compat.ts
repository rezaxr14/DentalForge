/**
 * `pnpm compat` — probe the local VLM-DENTAL checkout and print what this machine can actually run
 * (ADR-0024). Read-only: the probe imports modules and inspects signatures, never loads a model.
 *
 * Python selection: `VLM_PYTHON`, then `<VLM_DENTAL_PATH>/.venv/Scripts/python.exe` (Windows) or
 * `<path>/.venv/bin/python`, then `python`. Exit 0 when the probe ran; 2 when no checkout was found.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const checkout =
  process.env.VLM_DENTAL_PATH ??
  [resolve(process.cwd(), "..", "VLM-DENTAL"), resolve(process.cwd(), "..", "vlm-dental")].find((p) =>
    existsSync(join(p, "dental_agent")),
  ) ??
  "";

const venvCandidates = checkout
  ? [join(checkout, ".venv", "Scripts", "python.exe"), join(checkout, ".venv", "bin", "python")]
  : [];
const python = process.env.VLM_PYTHON ?? venvCandidates.find((p) => existsSync(p)) ?? "python";

const script = join(process.cwd(), "examples", "python-worker", "vlm_compat.py");
const args = [script, ...(checkout ? ["--path", checkout] : [])];
const r = spawnSync(python, args, { stdio: "inherit" });
if (r.error) {
  console.error(`[compat] could not run ${python}: ${r.error.message}`);
  process.exit(2);
}
process.exit(r.status ?? 1);
