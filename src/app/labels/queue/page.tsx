import Link from "next/link";
import { listLabels } from "@/shared/lib/fixtures";
import { QueueTable } from "./queue-table";

export default function QueuePage() {
  const labels = listLabels();
  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <p className="mb-2 inline-block rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
        Research prototype, not for clinical use
      </p>
      <Link href="/labels" className="text-sm underline">
        ← All images
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
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
    </main>
  );
}
