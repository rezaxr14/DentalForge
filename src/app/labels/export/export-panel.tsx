"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Annotation } from "@/shared/contracts/labels";
import {
  cocoExport, yoloLines, type ExportImage,
} from "@/shared/domain/annotation";
import { buildZip, listZipEntries, zipTextEntries } from "@/shared/domain/zip";
import { getSet } from "@/shared/lib/annotationStore";

type Format = "yolo" | "coco";
type Source = "mine" | "gt";

function download(bytes: Uint8Array, filename: string, mime: string): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function boxRows(images: ExportImage[], onlyApproved: boolean) {
  const byImage: Record<string, Annotation[]> = {};
  for (const img of images) {
    const set = getSet(img.id);
    const anns = (set?.annotations ?? []) as Annotation[];
    byImage[img.id] = onlyApproved
      ? anns.filter((a) => a.status === "approved")
      : anns.filter((a) => a.status === "approved" || a.status === "submitted");
  }
  return byImage;
}

export function ExportPanel({ images }: { images: ExportImage[] }) {
  const [format, setFormat] = useState<Format>("yolo");
  const [source, setSource] = useState<Source>("mine");
  const [onlyApproved, setOnlyApproved] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  const preview = useMemo(() => {
    if (source !== "mine") return null;
    const byImage = boxRows(images, onlyApproved);
    return images.map((img) => ({
      id: img.id,
      lines: yoloLines(byImage[img.id] ?? [], img.width, img.height, false),
      n: (byImage[img.id] ?? []).length,
    }));
  }, [images, source, onlyApproved]);

  const totalBoxes = preview?.reduce((n, r) => n + r.n, 0) ?? 0;

  const onDownload = (): void => {
    if (source !== "mine" || !preview) return;
    const byImage = boxRows(images, onlyApproved);
    if (format === "coco") {
      const doc = cocoExport(images, byImage, false);
      const enc = new TextEncoder();
      const zip = buildZip([
        { name: "annotations.json", content: enc.encode(JSON.stringify(doc, null, 1)) },
      ]);
      setMsg(
        `COCO: ${doc.annotations.length} annotations, ${doc.images.length} images → annotations.zip (${listZipEntries(zip).length} file).`,
      );
      download(zip, "labelforge-coco.zip", "application/zip");
      return;
    }
    const files = images.map((img) => ({
      name: `labels/${img.id}.txt`,
      text: `${yoloLines(byImage[img.id] ?? [], img.width, img.height, false).join("\n")}\n`,
    }));
    const names = [
      "# DentalForge LabelForge dataset.yaml",
      "train: images",
      "val: images",
      "",
      "names:",
      ...Array.from({ length: 32 }, (_, i) => `  ${i}: fdi_${String(i + 1).padStart(2, "0")}`),
    ].join("\n");
    const zip = buildZip(zipTextEntries([...files, { name: "dataset.yaml", text: names }]));
    setMsg(
      `YOLO: ${totalBoxes} boxes across ${images.length} images → labelforge-yolo.zip (${listZipEntries(zip).length} files).`,
    );
    download(zip, "labelforge-yolo.zip", "application/zip");
  };

  return (
    <div className="mt-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-xs text-zinc-600">Format</span>
        {(["yolo", "coco"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFormat(f)}
            className={`rounded border px-3 py-1 font-mono ${
              format === f ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-300 bg-white"
            }`}
          >
            {f}
          </button>
        ))}
        <span className="text-xs text-zinc-600">Source</span>
        {(["mine", "gt"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSource(s)}
            className={`rounded border px-3 py-1 font-mono ${
              source === s ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-300 bg-white"
            }`}
          >
            {s === "mine" ? "my sets" : "GT fixtures"}
          </button>
        ))}
        <label className="flex items-center gap-1.5 text-xs text-zinc-600">
          <input
            type="checkbox"
            checked={onlyApproved}
            onChange={(e) => setOnlyApproved(e.target.checked)}
          />
          approved only (else approved + submitted)
        </label>
      </div>

      {source === "gt" ? (
        <p className="rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
          GT lives in <span className="font-mono">fixtures/labels/*.json</span> — already
          COCO-shaped with boxes in original pixels. Convert a fixture with the same{" "}
          <span className="font-mono">cocoExport</span>/<span className="font-mono">yoloLines</span>{" "}
          functions (locked in <span className="font-mono">tests/m5-labels.test.ts</span>);
          nothing to download here that isn&apos;t already committed.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded border border-zinc-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-3 py-2">Image</th>
                  <th className="px-3 py-2">Exportable boxes</th>
                  <th className="px-3 py-2">Preview (first 3 lines)</th>
                  <th className="px-3 py-2">Annotate</th>
                </tr>
              </thead>
              <tbody>
                {preview?.map((r) => (
                  <tr key={r.id} className="border-t border-zinc-100">
                    <td className="px-3 py-2 font-mono">image {r.id}</td>
                    <td className="px-3 py-2 font-mono">{r.n}</td>
                    <td className="px-3 py-2 font-mono text-xs text-zinc-600">
                      {r.lines.slice(0, 3).join(" / ") || "—"}
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/labels/${r.id}`} className="text-xs underline">
                        Open →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            onClick={onDownload}
            disabled={totalBoxes === 0}
            className="rounded border border-zinc-900 bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-40"
          >
            Download {format === "yolo" ? "labelforge-yolo.zip" : "labelforge-coco.zip"}
          </button>
          {msg && <p className="text-sm text-zinc-700">{msg}</p>}
        </>
      )}
    </div>
  );
}
