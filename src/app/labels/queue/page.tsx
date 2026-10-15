import { listLabels } from "@/shared/lib/fixtures";
import { QueueTable } from "./queue-table";
import { BackLink, PageShell } from "@/shared/ui/page";

export default function QueuePage() {
  const labels = listLabels();
  return (
    <PageShell>
      <BackLink href="/labels">All images</BackLink>
      <h1 className="text-2xl font-semibold tracking-tight">
        Active-learning queue
        <span className="ml-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 align-middle text-xs font-normal text-amber-800">
          heuristic
        </span>
      </h1>
      <p className="mt-1 max-w-3xl text-sm text-zinc-600">
        No <span className="font-mono">al.score</span> worker exists, so scoring is a labeled
        heuristic (plan §9): prediction uncertainty (70%) blended with GT coverage gap (30%).
        Uncertainty comes from the real stored YOLO predictions; coverage counts your local
        human boxes against consensus GT.
      </p>
      <QueueTable
        images={labels.map((l) => ({
          id: l.id,
          image_path: l.image_path,
          gtCount: l.gtCount,
          meanConf: l.meanConf,
        }))}
      />
    </PageShell>
  );
}
