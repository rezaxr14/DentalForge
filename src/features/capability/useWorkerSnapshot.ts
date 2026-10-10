"use client";

/**
 * Session-aware worker snapshot for client components (plan §9.3).
 *
 * Fetched from `/api/worker/status` so pages that consume the ladder stay
 * static and never block on — or fail because of — the database (the same
 * contract as the header pill). `null` means "not loaded yet": callers resolve
 * the ladder with a conservative offline context until it arrives, so nothing
 * ever claims worker availability it has not observed.
 */
import { useEffect, useState } from "react";
import type { WorkerSnapshot } from "./service";

const REFRESH_MS = 30_000;

export function useWorkerSnapshot(): WorkerSnapshot | null {
  const [snap, setSnap] = useState<WorkerSnapshot | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/worker/status", { cache: "no-store" });
        const body = (await res.json()) as WorkerSnapshot;
        if (alive) setSnap(body);
      } catch {
        // Offline is an answer: keep the last good snapshot (or null → the
        // conservative offline resolution) instead of throwing.
      }
    };
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return snap;
}
