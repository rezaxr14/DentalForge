import { resolveDataSource } from "@/shared/lib/resolve-source";
import { EvalDetailSection } from "../page";
import { BackLink, PageShell } from "@/shared/ui/page";

export default async function EvalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { source } = await resolveDataSource();
  const detail = await source.getEvalCase(id);
  return (
    <PageShell>
      <BackLink href="/evals">Leaderboard</BackLink>
      <h1 className="text-2xl font-semibold tracking-tight">Eval case {id}</h1>
      {detail ? (
        <EvalDetailSection evalCase={detail.evalCase} />
      ) : (
        <p className="mt-6 text-sm text-zinc-600">
          Eval case not found in the {source.provenance} source.
        </p>
      )}
    </PageShell>
  );
}
