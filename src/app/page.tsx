import Link from "next/link";

const modules = [
  { href: "/traces", name: "Trace Explorer", desc: "Browse, replay, compare multi-turn agent traces" },
  { href: "/evals", name: "Eval Hub", desc: "Leaderboard with bootstrap CIs and calibration" },
  { href: "/labels", name: "LabelForge", desc: "Box annotation with FDI + pathology, review, export" },
  { href: "/tools", name: "Tool Lab", desc: "Run any of the 8 agent tools on an image" },
  { href: "/quality", name: "Data Quality", desc: "Verifier rejections, directive leaks, false positives" },
  { href: "/rewards", name: "Reward Inspector", desc: "GRPO reward components per trajectory" },
  { href: "/agent", name: "Live Agent", desc: "Stream an agent run, replay fallback" },
  { href: "/training", name: "Training Hub", desc: "SFT / GRPO / YOLO checkpoints and metrics" },
];

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <p className="mb-2 inline-block rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
        Research prototype, not for clinical use
      </p>
      <h1 className="text-3xl font-semibold tracking-tight">TraceForge</h1>
      <p className="mt-2 max-w-2xl text-sm text-zinc-600">
        Portfolio + curation workbench over real Dental-Agent artifacts. M0: schemas validated
        against real VLM-DENTAL traces and evals; every number below is computed from data.
      </p>
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {modules.map((m) => (
          <Link
            key={m.href}
            href={m.href}
            className="rounded-lg border p-4 transition-colors hover:border-zinc-400 hover:bg-zinc-50"
          >
            <div className="font-medium">{m.name}</div>
            <div className="mt-1 text-sm text-zinc-600">{m.desc}</div>
          </Link>
        ))}
      </div>
    </main>
  );
}
