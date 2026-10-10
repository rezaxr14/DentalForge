"use client";

/**
 * Header pill for worker status (plan §9.3). Fetched client-side so the root
 * layout — and every static page under it — stays static and never blocks on,
 * or fails because of, the database. Any failure renders `offline`.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import type { WorkerSnapshot } from "../service";
import { WorkerStatusPill } from "./WorkerStatusPill";

const REFRESH_MS = 30_000;

function ago(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 90 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

export function WorkerStatusBadge() {
  const [snap, setSnap] = useState<WorkerSnapshot | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/worker/status", { cache: "no-store" });
        const body = (await res.json()) as WorkerSnapshot;
        if (alive) setSnap(body);
      } catch {
        if (alive) setSnap(null);
      }
    };
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const newest = snap?.workers
    .map((w) => w.lastHeartbeatAt)
    .filter((x): x is string => x !== null)
    .sort()
    .at(-1) ?? null;

  return (
    <Link href="/status" aria-label="Worker status and capabilities">
      <WorkerStatusPill
        status={snap?.status ?? "offline"}
        declaredCapabilities={snap ? [...new Set(snap.workers.flatMap((w) => w.capabilities))] : undefined}
        lastSeenText={ago(newest)}
      />
    </Link>
  );
}
