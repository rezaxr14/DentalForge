import Link from "next/link";
import { listLabels } from "@/shared/lib/fixtures";
import { ExportPanel } from "./export-panel";

export default function ExportPage() {
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
        Export
        <span className="ml-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 align-middle text-xs font-normal text-amber-800">
          browser tier
        </span>
      </h1>
      <p className="mt-1 max-w-3xl text-sm text-zinc-600">
        Plan §9&apos;s export fallback is server-side streaming zip; with no server the browser
        tier wins instead (ADR-0005 §6): the same pure functions (
        <span className="font-mono">yoloLines</span>, <span className="font-mono">cocoExport</span>,
        store-only <span className="font-mono">buildZip</span>) run here and move into the
        dataset-exports path unchanged. Only <span className="font-mono">approved|submitted</span>{" "}
        annotations leave the app as training data.
      </p>
      <ExportPanel
        images={labels.map((l) => ({
          id: l.id,
          file: l.source_file,
          width: l.width,
          height: l.height,
        }))}
      />
    </main>
  );
}
