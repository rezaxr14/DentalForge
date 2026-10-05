import Link from "next/link";
import { Suspense } from "react";
import { getTrace } from "@/shared/lib/fixtures";
import { VerifiedTrace } from "@/shared/contracts/traces";

function TraceBody({ id }: { id: string }) {
  const raw = getTrace(id) as Record<string, unknown>;
  const parsed = VerifiedTrace.safeParse(raw);
  if (!parsed.success) {
    return (
      <div className="mt-6 rounded border p-4 text-sm">
        <p className="font-medium">Unverified trace (nested trajectory, not replayable yet).</p>
        <pre className="mt-2 overflow-auto text-xs text-zinc-600">
          {JSON.stringify(raw, null, 2).slice(0, 2000)}
        </pre>
      </div>
    );
  }
  const t = parsed.data;
  return (
    <div className="mt-6 space-y-4">
      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div className="rounded border p-2">Dataset: {t.dataset}</div>
        <div className="rounded border p-2">Image: {t.image_id}</div>
        <div className="rounded border p-2">Turns: {t.turns.length}</div>
        <div className="rounded border p-2">GT findings: {t.ground_truth.length}</div>
      </div>
      {t.turns.map((turn, i) => (
        <details key={i} className="rounded border p-3" open={i < 2}>
          <summary className="cursor-pointer text-sm font-medium">
            Turn {turn.turn}
            {turn.status ? ` · ${turn.status}` : ""}
            {turn.tool_calls_this_turn ? ` · ${turn.tool_calls_this_turn.length} tool calls` : ""}
          </summary>
          {turn.tool_calls_this_turn?.map((c, j) => (
            <div key={j} className="mt-2 rounded bg-zinc-50 p-2 font-mono text-xs">
              {c.tool_name}({JSON.stringify(c.tool_args)})
              {c.true_bbox ? ` · perturb:${c.perturb_tier}` : ""}
            </div>
          ))}
          {turn.parsed?.thought && (
            <p className="mt-2 text-sm text-zinc-700">{turn.parsed.thought.slice(0, 600)}</p>
          )}
          {turn.parsed?.final_answer && (
            <ul className="mt-2 text-sm">
              {turn.parsed.final_answer.map((f, k) => (
                <li key={k}>
                  Q{f.quadrant}T{f.tooth_position}: {f.diagnosis}
                  {f.confidence !== undefined ? ` (${f.confidence.toFixed(2)})` : ""}
                </li>
              ))}
            </ul>
          )}
        </details>
      ))}
    </div>
  );
}

export default async function TracePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <p className="mb-2 inline-block rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
        Research prototype, not for clinical use
      </p>
      <Link href="/traces" className="text-sm underline">
        ← All traces
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Trace {id}</h1>
      <Suspense fallback={<p className="mt-6 text-sm">Loading trace…</p>}>
        <TraceBody id={id} />
      </Suspense>
    </main>
  );
}
