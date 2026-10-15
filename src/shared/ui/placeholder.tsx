import { BackLink, PageShell } from "@/shared/ui/page";

export function Placeholder({ name, desc }: { name: string; desc: string }) {
  return (
    <PageShell>
      <BackLink href="/">Home</BackLink>
      <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
      <p className="mt-1 text-sm text-zinc-600">{desc}</p>
      <p className="mt-4 rounded border border-dashed p-4 text-sm text-zinc-500">
        Empty state — no data imported yet. This module lands in a later milestone.
      </p>
    </PageShell>
  );
}
