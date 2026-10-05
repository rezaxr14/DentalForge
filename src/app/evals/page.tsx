import Link from "next/link";
import { Suspense } from "react";
import { getEval, listEvals } from "@/shared/lib/fixtures";
import { EvalCase } from "@/shared/contracts/traces";

export function EvalsTable() {
  const rows = [...listEvals()].sort((a, b) => b.exactF1 - a.exactF1);
  return (
    <table className="mt-6 w-full text-sm">
      <thead>
        <tr className="border-b text-left text-zinc-500">
          <th className="py-2 pr-4">Model</th>
          <th className="py-2 pr-4">n</th>
          <th className="py-2 pr-4">exact F1</th>
          <th className="py-2">FDI F1</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-b hover:bg-zinc-50">
            <td className="py-2 pr-4">
              <Link href={`/evals/${r.id}`} className="font-medium underline">
                {r.model}
              </Link>
              <span className="ml-2 text-xs text-zinc-500">{r.provider}</span>
            </td>
            <td className="py-2 pr-4">{r.n}</td>
            <td className="py-2 pr-4">{r.exactF1.toFixed(3)}</td>
            <td className="py-2">{r.fdiF1.toFixed(3)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function EvalsPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <p className="mb-2 inline-block rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
        Research prototype, not for clinical use
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">Eval Hub</h1>
      <p className="mt-1 text-sm text-zinc-600">
        Means over full real JSONL files (verified in M0, see ADR-0001). Fixture holds one case
        per model for drill-down.
      </p>
      <Suspense fallback={<p className="mt-6 text-sm">Loading leaderboard…</p>}>
        <EvalsTable />
      </Suspense>
    </main>
  );
}

export function EvalDetail({ id }: { id: string }) {
  const c = EvalCase.parse(getEval(id) as unknown);
  return (
    <div className="mt-6 space-y-4 text-sm">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded border p-2">exact F1: {c.exact_f1.toFixed(3)}</div>
        <div className="rounded border p-2">FDI F1: {c.fdi_f1.toFixed(3)}</div>
        <div className="rounded border p-2">closeness: {c.closeness_score.toFixed(3)}</div>
        <div className="rounded border p-2">format: {c.format_ok ? "ok" : "bad"}</div>
      </div>
      <div className="rounded border p-3">
        <p className="font-medium">Matched pairs ({c.matched_pairs.length})</p>
        <ul className="mt-2 space-y-1">
          {c.matched_pairs.slice(0, 10).map((p, i) => (
            <li key={i}>
              GT Q{p.gt.quadrant}T{p.gt.tooth_position} {p.gt.diagnosis} → pred Q
              {p.pred.quadrant}T{p.pred.tooth_position} {p.pred.diagnosis} · fdi:
              {String(p.fdi_match)} exact:{String(p.exact_match)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function EvalDetailSection({ id }: { id: string }) {
  return (
    <Suspense fallback={<p className="mt-6 text-sm">Loading case…</p>}>
      <EvalDetail id={id} />
    </Suspense>
  );
}
