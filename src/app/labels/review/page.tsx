import { getLabel } from "@/shared/lib/fixtures";
import { ReviewBoard } from "./review-board";
import { BackLink, PageShell } from "@/shared/ui/page";

export default function ReviewPage() {
  // GT reference sets, validated server-side; user sets hydrate client-side.
  const refs = ["1", "2", "3", "4", "5"].map((id) => {
    const f = getLabel(id);
    return { id: f.id, gt: f.gt, width: f.width, height: f.height };
  });
  return (
    <PageShell>
      <BackLink href="/labels">All images</BackLink>
      <h1 className="text-2xl font-semibold tracking-tight">Review</h1>
      <p className="mt-1 max-w-3xl text-sm text-zinc-600">
        Adjudicate submitted sets against the DENTEX consensus GT with
        inter-annotator agreement (IoU≥0.5 match, Cohen&apos;s κ).
      </p>
      <ReviewBoard refs={refs} />
    </PageShell>
  );
}
