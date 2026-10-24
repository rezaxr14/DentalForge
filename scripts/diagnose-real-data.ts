/**
 * `pnpm diagnose:data [dir]` — where does the owner's REAL local data disagree with the zod contracts?
 *
 * Read-only. Validates every line of ../VLM-DENTAL/data/evaluations/zero_shot_*.jsonl against `EvalCase` and
 * every data/traces/train_cot_traces*.jsonl against `VerifiedTrace`, then lists each failing path once with how
 * many lines it affects and one example VALUE DESCRIPTION (type/number/null/length — never strings from the data).
 * One run shows every mismatch, instead of the first failure per line (ADR-0014).
 *
 * ADR-0024 adds the adapter counts: lines read, lines skipped, unknown field names (kept under `extra`, never
 * dropped silently) and observed schema-shape variants, per file.
 *
 * Exit code 0 when every line validates, 1 otherwise, 2 when no data was found.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { EvalCase, VerifiedTrace } from "@/shared/contracts/traces";
import { diagnoseLines, type Diagnosis } from "@/shared/lib/import/diagnose";
import { traceFileMeta } from "@/shared/lib/import/parse";
import { scanEvalLines, scanTraceLines, type AdapterDiagnostics } from "@/shared/vlm/adapters";

const arg = process.argv[2];
const VLM_DATA = arg
  ? resolvePath(arg)
  : process.env.VLM_DENTAL_DIR
    ? join(process.env.VLM_DENTAL_DIR, "data")
    : resolvePath(process.cwd(), "..", "VLM-DENTAL", "data");

function adapterLines(d: AdapterDiagnostics): string[] {
  const lines: string[] = [];
  const unknown = Object.entries(d.unknownFields).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const variants = Object.entries(d.variants).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  lines.push(
    `       adapter ${d.adapter}/${d.version}: ${d.linesRead} read, ${d.linesSkipped} skipped` +
      (unknown.length ? `, ${unknown.length} unknown field(s)` : "") +
      (variants.length ? `, ${variants.length} shape variant(s)` : ""),
  );
  for (const [name, count] of unknown) lines.push(`       ${String(count).padStart(5)} line(s)  unknown field ${name} (kept in extra)`);
  for (const [name, count] of variants) lines.push(`       ${String(count).padStart(5)} line(s)  variant ${name}`);
  for (const s of d.skipped) lines.push(`       line ${s.line}: ${s.reason}`);
  return lines;
}

function report(label: string, d: Diagnosis, adapter: AdapterDiagnostics): boolean {
  const ok = d.invalid === 0;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${d.total} lines, ${d.valid} valid${ok ? "" : `, ${d.invalid} invalid${d.notJson ? ` (${d.notJson} not JSON)` : ""}`}`);
  for (const p of d.byPath) console.log(`       ${String(p.lines).padStart(5)} line(s)  ${p.path}  [${p.code}] ${p.message}  e.g. ${p.example}`);
  for (const line of adapterLines(adapter)) console.log(line);
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
  const lines = readFileSync(join(evalDir, f), "utf8").split(/\r?\n/);
  allOk = report(`eval   ${f}`, diagnoseLines(EvalCase, lines), scanEvalLines(f, lines)) && allOk;
}
for (const f of traceFiles) {
  const lines = readFileSync(join(traceDir, f), "utf8").split(/\r?\n/);
  allOk = report(`trace  ${f}`, diagnoseLines(VerifiedTrace, lines), scanTraceLines(lines, f, traceFileMeta(f))) && allOk;
}
console.log(allOk ? "[diagnose] every line validates" : "[diagnose] data and contracts disagree — see FAIL lines above");
process.exit(allOk ? 0 : 1);
