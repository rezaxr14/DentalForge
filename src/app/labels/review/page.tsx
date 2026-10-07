import Link from "next/link";
import { getLabel } from "@/shared/lib/fixtures";
import { ReviewBoard } from "./review-board";

export default function ReviewPage() {
  // GT reference sets, validated server-side; user sets hydrate client-side.
  const refs = ["1", "2", "3", "4", "5"].map((id) => {
    const f = getLabel(id);
    return { id: f.id, gt: f.gt, width: f.width, height: f.height };
  });
  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <p className="mb-2 inline-block rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
        Research prototype, not for clinical use
      </p>
      <Link href="/labels" className="text-sm underline">
        ← All images
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Review</h1>
      <p className="mt-1 max-w-3xl text-sm text-zinc-600">
        Adjudicate submitted sets against the DENTEX consensus GT with
        inter-annotator agreement (IoU≥0.5 match, Cohen&apos;s κ). Decisions are
        recorded locally (ADR-0005 §4); the role switcher is a demo stand-in —
        no auth exists yet.
      </p>
      <ReviewBoard refs={refs} />
    </main>
  );
}
