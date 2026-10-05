import Link from "next/link";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface FileStats {
  n: number;
  directive_leak: number;
  statuses: Record<string, number>;
  tools: Record<string, number>;
  unknown_tools: Record<string, number>;
  healthy_false_positives: number;
}

interface QualityStats {
  n_files: number;
  n_traces: number;
  overall_tools: Record<string, number>;
  overall_statuses: Record<string, number>;
  overall_unknown_tools: Record<string, number>;
  perturb_tiers: Record<string, number>;
  per_file: Record<string, FileStats>;
}

function loadStats(): QualityStats {
  return JSON.parse(
    readFileSync(join(process.cwd(), "fixtures", "goldens", "m3_quality.json"), "utf-8"),
  ) as QualityStats;
}

function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-44 truncate font-mono text-xs">{label}</span>
      <div className="h-3 flex-1 rounded bg-zinc-100">
        <div className="h-3 rounded bg-zinc-700" style={{ width: `${max > 0 ? (value / max) * 100 : 0}%` }} />
      </div>
      <span className="w-16 text-right tabular-nums">{value.toLocaleString()}</span>
    </div>
  );
}

export default function QualityPage() {
  const s = loadStats();
  const maxTool = Math.max(...Object.values(s.overall_tools));
  const maxStatus = Math.max(...Object.values(s.overall_statuses));
  const totalLeak = Object.values(s.per_file).reduce((a, f) => a + f.directive_leak, 0);
  const totalFp = Object.values(s.per_file).reduce((a, f) => a + f.healthy_false_positives, 0);
  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <p className="mb-2 inline-block rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
        Research prototype, not for clinical use
      </p>
      <Link href="/" className="text-sm underline">← Home</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Data Quality</h1>
      <p className="mt-1 text-sm text-zinc-600">
        Scanned from {s.n_traces.toLocaleString()} trace rows across {s.n_files} files. Note: hybrid
        files duplicate per-cohort files (see ADR-0001), so row counts over-count unique cases —
        per-file breakdown below.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div className="rounded border p-3">
          <p className="text-zinc-500">Directive leaks</p>
          <p className="text-2xl font-semibold">{totalLeak.toLocaleString()}</p>
          <p className="text-xs text-zinc-500">TEACHER DIRECTIVE in user messages</p>
        </div>
        <div className="rounded border p-3">
          <p className="text-zinc-500">Verifier rejections</p>
          <p className="text-2xl font-semibold">{(s.overall_statuses.rejected_final_answer ?? 0).toLocaleString()}</p>
          <p className="text-xs text-zinc-500">rejected_final_answer turns</p>
        </div>
        <div className="rounded border p-3">
          <p className="text-zinc-500">Healthy false positives</p>
          <p className="text-2xl font-semibold">{totalFp.toLocaleString()}</p>
          <p className="text-xs text-zinc-500">empty GT but non-empty final</p>
        </div>
        <div className="rounded border p-3">
          <p className="text-zinc-500">Unknown tool names</p>
          <p className="text-2xl font-semibold">
            {Object.values(s.overall_unknown_tools).reduce((a, b) => a + b, 0).toLocaleString()}
          </p>
          <p className="text-xs text-zinc-500">{Object.keys(s.overall_unknown_tools).join(", ")}</p>
        </div>
      </div>

      <h2 className="mt-8 font-medium">Tool usage</h2>
      <div className="mt-2 space-y-1">
        {Object.entries(s.overall_tools).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
          <Bar key={k} label={k} value={v} max={maxTool} />
        ))}
      </div>

      <h2 className="mt-8 font-medium">Turn statuses</h2>
      <div className="mt-2 space-y-1">
        {Object.entries(s.overall_statuses).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
          <Bar key={k} label={k} value={v} max={maxStatus} />
        ))}
      </div>

      <h2 className="mt-8 font-medium">Per-file breakdown</h2>
      <table className="mt-2 w-full text-sm">
        <thead>
          <tr className="border-b text-left text-zinc-500">
            <th className="py-2 pr-4">File</th>
            <th className="py-2 pr-4">Rows</th>
            <th className="py-2 pr-4">Leak</th>
            <th className="py-2 pr-4">Rejected</th>
            <th className="py-2">Unparseable</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(s.per_file).map(([file, f]) => (
            <tr key={file} className="border-b font-mono text-xs">
              <td className="py-2 pr-4">{file.replace("train_cot_traces", "…").replace(".jsonl", "")}</td>
              <td className="py-2 pr-4">{f.n}</td>
              <td className="py-2 pr-4">{f.directive_leak}</td>
              <td className="py-2 pr-4">{f.statuses.rejected_final_answer ?? 0}</td>
              <td className="py-2">
                {(f.statuses.unparseable_retry ?? 0) + (f.statuses.invalid_tool_format ?? 0)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

