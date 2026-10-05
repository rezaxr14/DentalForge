import Link from "next/link";
import { getEval } from "@/shared/lib/fixtures";
import { EvalCase } from "@/shared/contracts/traces";

export default async function EvalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = EvalCase.parse(getEval(id) as unknown);
  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <p className="mb-2 inline-block rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
        Research prototype, not for clinical use
      </p>
      <Link href="/evals" className="text-sm underline">
        ← Leaderboard
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Eval case {id}</h1>
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
    </main>
  );
}
