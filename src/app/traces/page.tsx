import Link from "next/link";
import { listTraces } from "@/shared/lib/fixtures";

export default function TracesPage() {
  const traces = listTraces();
  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <p className="mb-2 inline-block rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
        Research prototype, not for clinical use
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">Trace Explorer</h1>
      <p className="mt-1 text-sm text-zinc-600">
        {traces.length} fixture traces. All counts computed from fixture data.
      </p>
      <table className="mt-6 w-full text-sm">
        <thead>
          <tr className="border-b text-left text-zinc-500">
            <th className="py-2 pr-4">Trace</th>
            <th className="py-2 pr-4">Dataset</th>
            <th className="py-2 pr-4">Mode</th>
            <th className="py-2 pr-4">Turns</th>
            <th className="py-2 pr-4">Tool calls</th>
            <th className="py-2 pr-4">Findings</th>
            <th className="py-2">Format</th>
          </tr>
        </thead>
        <tbody>
          {traces.map((t) => (
            <tr key={t.id} className="border-b hover:bg-zinc-50">
              <td className="py-2 pr-4">
                <Link href={`/traces/${t.id}`} className="font-medium underline">
                  {t.id}
                </Link>
                {!t.verified && (
                  <span className="ml-2 rounded bg-zinc-200 px-1 text-xs">unverified</span>
                )}
              </td>
              <td className="py-2 pr-4">
                {t.dataset} · img {t.imageId}
              </td>
              <td className="py-2 pr-4">{t.mode}</td>
              <td className="py-2 pr-4">{t.nTurns}</td>
              <td className="py-2 pr-4">{t.nToolCalls}</td>
              <td className="py-2 pr-4">{t.nFindings}</td>
              <td className="py-2">{t.formatOk ? "ok" : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
