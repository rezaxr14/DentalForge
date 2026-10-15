import { notFound } from "next/navigation";
import { getLabel, listLabels } from "@/shared/lib/fixtures";
import { LabelEditor } from "./label-editor";
import { BackLink, PageShell } from "@/shared/ui/page";

export function generateStaticParams() {
  return listLabels().map((l) => ({ imageId: l.id }));
}

export default async function LabelImagePage({ params }: { params: Promise<{ imageId: string }> }) {
  const { imageId } = await params;
  let fixture;
  try {
    fixture = getLabel(imageId);
  } catch {
    notFound();
  }
  return (
    <PageShell>
      <BackLink href="/labels">All images</BackLink>
      <h1 className="text-2xl font-semibold tracking-tight">
        Annotate image {fixture.id}
        <span className="ml-2 font-mono text-sm font-normal text-zinc-500">
          {fixture.source_file} · {fixture.width}×{fixture.height}
        </span>
      </h1>
      <LabelEditor fixture={fixture} />
    </PageShell>
  );
}
