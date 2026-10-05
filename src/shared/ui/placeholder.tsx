import Link from "next/link";

export function Placeholder({ name, desc }: { name: string; desc: string }) {
  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <p className="mb-2 inline-block rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
        Research prototype, not for clinical use
      </p>
      <Link href="/" className="text-sm underline">
        ← Home
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{name}</h1>
      <p className="mt-1 text-sm text-zinc-600">{desc}</p>
      <p className="mt-4 rounded border border-dashed p-4 text-sm text-zinc-500">
        Empty state — no data imported yet. This module lands in a later milestone.
      </p>
    </main>
  );
}
