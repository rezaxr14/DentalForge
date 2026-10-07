"use client";

import { useMemo } from "react";
import Link from "next/link";
import { alQueueScore } from "@/shared/domain/annotation";
import { getSet } from "@/shared/lib/annotationStore";

interface QueueImage {
  id: string;
  image_path: string;
  gtCount: number;
  meanConf: number | null;
}

export function QueueTable({ images }: { images: QueueImage[] }) {
  const rows = useMemo(
    () =>
      images
        .map((img) => {
          const local = getSet(img.id);
          const labeled = local?.annotations.length ?? 0;
          const s = alQueueScore({
            meanConf: img.meanConf,
            gtBoxes: img.gtCount,
            labeledBoxes: labeled,
          });
          return { ...img, labeled, state: local?.state ?? "unstarted", score: s.score };
        })
        .sort((a, b) => b.score - a.score || Number(a.id) - Number(b.id)),
    [images],
  );
  return (
    <div className="mt-6 overflow-x-auto rounded border border-zinc-200">
      <table className="w-full text-left text-sm">
        <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="px-3 py-2">Priority</th>
            <th className="px-3 py-2">Image</th>
            <th className="px-3 py-2">GT</th>
            <th className="px-3 py-2">Your boxes</th>
            <th className="px-3 py-2">Mean pre-label conf</th>
            <th className="px-3 py-2">Score</th>
            <th className="px-3 py-2">Strategy</th>
            <th className="px-3 py-2">Link</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className="border-t border-zinc-100">
              <td className="px-3 py-2 font-mono">#{i + 1}</td>
              <td className="px-3 py-2">
                <span className="font-mono">image {r.id}</span>{" "}
                <span className="rounded border border-zinc-300 bg-zinc-50 px-1.5 py-0.5 text-xs">
                  {r.state}
                </span>
              </td>
              <td className="px-3 py-2 font-mono">{r.gtCount}</td>
              <td className="px-3 py-2 font-mono">{r.labeled}</td>
              <td className="px-3 py-2 font-mono">
                {r.meanConf == null ? "n/a" : r.meanConf.toFixed(3)}
              </td>
              <td className="px-3 py-2 font-mono font-medium">{r.score.toFixed(3)}</td>
              <td className="px-3 py-2 font-mono text-xs">uncertainty+coverage</td>
              <td className="px-3 py-2">
                <Link href={`/labels/${r.id}`} className="text-xs underline">
                  Annotate →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
