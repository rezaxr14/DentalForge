import Link from "next/link";
import { notFound } from "next/navigation";
import { getLabel, listLabels } from "@/shared/lib/fixtures";
import { LabelEditor } from "./label-editor";

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
    <main className="mx-auto max-w-6xl px-6 py-8">
      <p className="mb-2 inline-block rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
        Research prototype, not for clinical use
      </p>
      <Link href="/labels" className="text-sm underline">
        ← All images
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        Annotate image {fixture.id}
        <span className="ml-2 font-mono text-sm font-normal text-zinc-500">
          {fixture.source_file} · {fixture.width}×{fixture.height}
        </span>
      </h1>
      <LabelEditor fixture={fixture} />
    </main>
  );
}
