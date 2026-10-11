/**
 * `pnpm diagnose:data [dir]` — where does the owner's REAL local data disagree with the zod contracts?
 *
 * Read-only. Validates every line of ../VLM-DENTAL/data/evaluations/zero_shot_*.jsonl against `EvalCase` and
 * every data/traces/train_cot_traces*.jsonl against `VerifiedTrace`, then lists each failing path once with how
 * many lines it affects and one example VALUE DESCRIPTION (type/number/null/length — never strings from the data).
 * One run shows every mismatch, instead of the first failure per line (ADR-0014).
 *
 * Exit code 0 when every line validates, 1 otherwise, 2 when no data was found.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { EvalCase, VerifiedTrace } from "@/shared/contracts/traces";
import { diagnoseLines, type Diagnosis } from "@/shared/lib/import/diagnose";

const arg = process.argv[2];
const VLM_DATA = arg
  ? resolvePath(arg)
  : process.env.VLM_DENTAL_DIR
    ? join(process.env.VLM_DENTAL_DIR, "data")
    : resolvePath(process.cwd(), "..", "VLM-DENTAL", "data");

function report(label: string, d: Diagnosis): boolean {
  const ok = d.invalid === 0;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${d.total} lines, ${d.valid} valid${ok ? "" : `, ${d.invalid} invalid${d.notJson ? ` (${d.notJson} not JSON)` : ""}`}`);
  for (const p of d.byPath) console.log(`       ${String(p.lines).padStart(5)} line(s)  ${p.path}  [${p.code}] ${p.message}  e.g. ${p.example}`);
  return ok;
}

function files(dir: string, keep: (f: string) => boolean): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl") && keep(f)).sort() : [];
}

const evalDir = join(VLM_DATA, "evaluations");
const traceDir = join(VLM_DATA, "traces");
const evalFiles = files(evalDir, (f) => f.startsWith("zero_shot_"));
const traceFiles = files(traceDir, (f) => f.startsWith("train_cot_traces") && !f.includes("unverified"));

if (evalFiles.length + traceFiles.length === 0) {
  console.error(`[diagnose] no eval or trace files under ${VLM_DATA} (set VLM_DENTAL_DIR or pass the data directory)`);
  process.exit(2);
}

let allOk = true;
console.log(`[diagnose] ${VLM_DATA}`);
for (const f of evalFiles) {
  allOk = report(`eval   ${f}`, diagnoseLines(EvalCase, readFileSync(join(evalDir, f), "utf8").split(/\r?\n/))) && allOk;
}
for (const f of traceFiles) {
  allOk = report(`trace  ${f}`, diagnoseLines(VerifiedTrace, readFileSync(join(traceDir, f), "utf8").split(/\r?\n/))) && allOk;
}
console.log(allOk ? "[diagnose] every line validates" : "[diagnose] data and contracts disagree — see FAIL lines above");
process.exit(allOk ? 0 : 1);
