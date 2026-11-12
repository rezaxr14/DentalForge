import { readFileSync } from "node:fs";
import { join } from "node:path";
import Link from "next/link";
import { resolveDataSource } from "@/shared/lib/resolve-source";
import { PageShell } from "@/shared/ui/page";
import { Badge, Card, Stat } from "@/shared/ui/primitives";

// Reads per-request state (the demo org, seeded rows): never freeze it into HTML at build time.
export const dynamic = "force-dynamic";

type Manifest = {
  vlmDental?: { commit?: string; branch?: string; dirty?: boolean };
  buildDate?: string;
  counts?: Record<string, number>;
  licenses?: Record<string, string>;
};

function readManifest(): Manifest | null {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "demo", "MANIFEST.json"), "utf8")) as Manifest;
  } catch {
    return null;
  }
}

export const metadata = {
  title: "Data and licences — TraceForge",
  description:
    "What the TraceForge demo contains, where it came from, and the DENTEX / Ultralytics licence terms.",
};

export default async function AboutDataPage() {
  const manifest = readManifest();
  const { source } = await resolveDataSource();
  const traces = await source.listTraces();
  const evals = await source.listEvalRuns();

  return (
    <PageShell className="py-10">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Data and licences</h1>
        <Badge tone="warning">research use only</Badge>
      </div>
      <p className="mt-2 max-w-3xl text-sm text-zinc-600">
        This site is a portfolio and curation workbench over real dental-agent artifacts. It is not a
        medical device and must not be used for diagnosis or treatment.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Public traces" value={traces.length} />
        <Stat label="Eval runs" value={evals.length} />
        <Stat label="Eval cases" value={evals.reduce((n, r) => n + r.n, 0)} />
        <Stat label="Dataset" value="DENTEX" hint="CC BY-NC-SA 4.0" />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card className="p-6">
            <h2 className="text-lg font-semibold tracking-tight">What is included</h2>
            <ul className="mt-3 space-y-2 text-sm text-zinc-700 dark:text-zinc-300">
              <li>
                <strong>Radiographs.</strong> Downscaled JPEG derivatives of DENTEX panoramic X-rays. Only
                DENTEX images are published; Tufts data is never included in the bundle, the database seed,
                or the deployed site.
              </li>
              <li>
                <strong>Traces.</strong> Recorded multi-turn trajectories with tool calls, verifier outcomes
                and final answers. Each card states its cohort (with tools / no tools) and verification state.
                These are teacher-generated SFT training traces: a frontier LLM produced them in a tool loop
                with ground-truth guidance, and a different model family checked the format. They are
                supervision data, not a trained model&apos;s performance; performance numbers appear only on
                <code className="mx-1">/evals</code>.
              </li>
              <li>
                <strong>Evaluations.</strong> Zero-shot runs over the DENTEX test split, with per-case exact
                and FDI metrics and reported confidence.
              </li>
              <li>
                <strong>Tool renders.</strong> Real tool outputs (zoom crops, contrast, detection) linked to
                the tool call that produced them. Missing renders show the recorded arguments instead.
              </li>
              <li>
                <strong>Grounding checkpoint.</strong> The advertised YOLO family was trained on DENTEX only.
                The multi-dataset checkpoint is not used or redistributed.
              </li>
            </ul>
          </Card>

          <Card className="p-6">
            <h2 className="text-lg font-semibold tracking-tight">What is not included</h2>
            <ul className="mt-3 space-y-2 text-sm text-zinc-700 dark:text-zinc-300">
              <li>Tufts radiographs, Tufts-derived traces, evaluations or weights.</li>
              <li>Base model weights. Model identifiers are referenced; weights are not redistributed.</li>
              <li>Provider keys, request ids, absolute paths and usernames — the bundle build is allow-list based.</li>
              <li>SFT or GRPO results. Those stages have not been run yet, and no target numbers are shown.</li>
            </ul>
          </Card>

          <Card className="p-6">
            <h2 className="text-lg font-semibold tracking-tight">Licences</h2>
            <div className="mt-3 space-y-4 text-sm text-zinc-700 dark:text-zinc-300">
              <div>
                <h3 className="font-medium">DENTEX — CC BY-NC-SA 4.0</h3>
                <p className="mt-1 text-xs text-zinc-600">
                  Dental Enumeration and Diagnosis on Panoramic X-rays Challenge, MICCAI 2023. The dataset
                  card permits non-commercial research use with attribution and share-alike terms. The
                  downscaled images and overlays on this site are derivatives under the same licence.
                </p>
                <ul className="mt-2 space-y-1 text-xs">
                  <li>
                    Dataset:{" "}
                    <a className="underline" href="https://huggingface.co/datasets/ibrahimhamamci/DENTEX">
                      huggingface.co/datasets/ibrahimhamamci/DENTEX
                    </a>
                  </li>
                  <li>
                    Challenge:{" "}
                    <a className="underline" href="https://dentex.grand-challenge.org/data/">
                      dentex.grand-challenge.org/data
                    </a>
                  </li>
                  <li>Paper: Hamamci et al., arXiv:2305.19112 (MICCAI 2023).</li>
                </ul>
              </div>
              <div>
                <h3 className="font-medium">Ultralytics YOLO — AGPL-3.0</h3>
                <p className="mt-1 text-xs text-zinc-600">
                  The grounding tool uses the Ultralytics implementation. The DENTEX-only checkpoint family
                  is referenced for research; weights are not served from this site.
                </p>
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="p-5">
            <h2 className="text-sm font-semibold">Bundle provenance</h2>
            {manifest ? (
              <dl className="mt-3 space-y-2 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">Source commit</dt>
                  <dd className="font-mono">{manifest.vlmDental?.commit?.slice(0, 12) ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">Branch</dt>
                  <dd className="font-mono">{manifest.vlmDental?.branch ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-zinc-500">Built</dt>
                  <dd className="font-mono">{manifest.buildDate?.slice(0, 10) ?? "—"}</dd>
                </div>
                {Object.entries(manifest.counts ?? {}).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3">
                    <dt className="capitalize text-zinc-500">{k.replace(/([A-Z])/g, " $1")}</dt>
                    <dd className="font-mono tabular-nums">{v}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="mt-2 text-xs text-zinc-600">
                No build manifest is present in this deployment; counts above come from the live data source.
              </p>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="text-sm font-semibold">Status vocabulary</h2>
            <dl className="mt-3 space-y-2 text-xs">
              <div>
                <dt className="font-medium">Recorded / imported</dt>
                <dd className="text-zinc-600">Read from the committed bundle or the imported database rows.</dd>
              </div>
              <div>
                <dt className="font-medium">Fixture replay</dt>
                <dd className="text-zinc-600">A small committed sample; used when the database is unavailable.</dd>
              </div>
              <div>
                <dt className="font-medium">Not run yet</dt>
                <dd className="text-zinc-600">SFT and GRPO stages, until real records exist.</dd>
              </div>
              <div>
                <dt className="font-medium">Test backend</dt>
                <dd className="text-zinc-600">A small local model used to exercise the live path, not the research model.</dd>
              </div>
            </dl>
          </Card>

          <Card className="p-5">
            <h2 className="text-sm font-semibold">Report a problem</h2>
            <p className="mt-2 text-xs text-zinc-600">
              The project is open source. Issues about data or licensing are welcome.
            </p>
            <Link href="/status" className="mt-2 inline-block text-xs font-medium text-sky-700 hover:underline dark:text-sky-400">
              System status →
            </Link>
          </Card>
        </div>
      </div>
    </PageShell>
  );
}
