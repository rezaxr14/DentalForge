import Link from "next/link";
import { resolveDataSource } from "@/shared/lib/resolve-source";
import { EvalDetailSection } from "../page";

export default async function EvalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { source } = await resolveDataSource();
  const detail = await source.getEvalCase(id);
  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <p className="mb-2 inline-block rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
        Research prototype, not for clinical use
      </p>
      <Link href="/evals" className="text-sm underline">
        ← Leaderboard
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Eval case {id}</h1>
      {detail ? (
        <EvalDetailSection evalCase={detail.evalCase} />
      ) : (
        <p className="mt-6 text-sm text-zinc-600">
          Eval case not found in the {source.provenance} source.
        </p>
      )}
    </main>
  );
}
