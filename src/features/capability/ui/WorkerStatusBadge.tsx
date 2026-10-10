"use client";

/**
 * Header pill for worker status (plan §9.3). Fetched client-side so the root
 * layout — and every static page under it — stays static and never blocks on,
 * or fails because of, the database. Any failure renders `offline`.
 */
import Link from "next/link";
import { useWorkerSnapshot } from "../useWorkerSnapshot";
import { WorkerStatusPill } from "./WorkerStatusPill";

function ago(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 90 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

export function WorkerStatusBadge() {
  const snap = useWorkerSnapshot();

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
