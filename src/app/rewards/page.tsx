import Link from "next/link";
import { getTrace } from "@/shared/lib/fixtures";
import { VerifiedTrace } from "@/shared/contracts/traces";
import { combineReward } from "@/shared/domain/composite";

export default async function RewardsPage({ searchParams }: { searchParams: Promise<{ trace?: string }> }) {
  const { trace: traceId = "verified_with_tools" } = await searchParams;
  const raw = getTrace(traceId) as Record<string, unknown>;
  const parsed = VerifiedTrace.safeParse(raw);
  if (!parsed.success) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-8">
        <p className="mb-2 inline-block rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
          Research prototype, not for clinical use
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Reward Inspector</h1>
        <p className="mt-2 text-sm">Trace {traceId} is not a verified trace.</p>
      </main>
    );
  }
  const t = parsed.data;
  const { total, components } = combineReward(
    { format_ok: t.format_ok, final_answer: t.final_answer, turns: t.turns },
    t.ground_truth,
  );
  const rows: [string, number, number][] = [
    ["accuracy × 1.0", components.accuracy, 1.0 * components.accuracy],
    ["format × 0.2", components.format, 0.2 * components.format],
    ["tool_validity × 0.2", components.tool_validity, 0.2 * components.tool_validity],
    ["efficiency × 0.1", components.efficiency, 0.1 * components.efficiency],
  ];
  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <p className="mb-2 inline-block rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
        Research prototype, not for clinical use
      </p>
      <Link href="/" className="text-sm underline">← Home</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Reward Inspector</h1>
      <p className="mt-1 text-sm text-zinc-600">
        GRPO reward recomputed in TypeScript (parity-tested port) for trace{" "}
        <Link href={`/traces/${traceId}`} className="underline">{traceId}</Link>.
      </p>
      <div className="mt-6 rounded border p-4">
        <p className="text-sm text-zinc-500">Total reward</p>
        <p className="text-3xl font-semibold">{total.toFixed(4)}</p>
      </div>
      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="border-b text-left text-zinc-500">
            <th className="py-2 pr-4">Component</th>
            <th className="py-2 pr-4">Raw</th>
            <th className="py-2">Weighted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, rawV, w]) => (
            <tr key={name} className="border-b">
              <td className="py-2 pr-4 font-medium">{name}</td>
              <td className="py-2 pr-4">{rawV.toFixed(4)}</td>
              <td className="py-2">{w.toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

