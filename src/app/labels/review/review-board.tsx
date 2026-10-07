"use client";

import { useState } from "react";
import Link from "next/link";
import type { Annotation } from "@/shared/contracts/labels";
import { agreementStats } from "@/shared/domain/annotation";
import {
  applyDecision, getDecisions, getRole, listSets, resetAll, setRole,
} from "@/shared/lib/annotationStore";

export interface GtRef {
  id: string;
  gt: Annotation[];
  width: number;
  height: number;
}

function kappa(v: number | null): string {
  return v == null ? "n/a" : v.toFixed(3);
}

export function ReviewBoard({ refs }: { refs: GtRef[] }) {
  const [tick, setTick] = useState(0);
  // Lazy hydration from localStorage keeps SSR output identical (default "user").
  const [role, setRoleState] = useState<"user" | "reviewer" | "admin">(() => getRole());
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const sets = listSets();
  const switchRole = (r: "user" | "reviewer" | "admin"): void => {
    setRoleState(r);
    setRole(r);
  };

  const decide = (imageId: string, decision: "approved" | "rejected"): void => {
    const res = applyDecision(imageId, decision, reason, role);
    if (!res.ok) {
      setMsg(`Review failed (${res.code}): ${res.reason}`);
    } else {
      setReason("");
      setMsg(`image ${imageId}: ${decision}.`);
    }
    setTick((t) => t + 1);
  };

  return (
    <div className="mt-6 space-y-4" key={tick}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-zinc-600">Demo role:</span>
        {(["user", "reviewer", "admin"] as const).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => switchRole(r)}
            className={`rounded border px-2 py-1 ${
              role === r ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-300 bg-white"
            }`}
          >
            {r}
          </button>
        ))}
        <span className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-700">
          approves/rejects require reviewer or admin (self-review is blocked)
        </span>
        <button
          type="button"
          onClick={() => {
            resetAll();
            setTick((t) => t + 1);
            setMsg("Local annotation state cleared.");
          }}
          className="ml-auto rounded border border-zinc-300 bg-white px-2 py-1 text-zinc-600"
        >
          Reset local state
        </button>
      </div>
      {msg && <p className="text-sm text-zinc-700">{msg}</p>}

      {refs.map((ref) => {
        const set = sets.find((s) => s.image_id === ref.id);
        const stats = set
          ? agreementStats(ref.id, set.assignee_id, "gt_import", set.annotations, ref.gt)
          : null;
        const decisions = getDecisions(ref.id);
        return (
          <section key={ref.id} className="rounded border border-zinc-200 p-4">
            <div className="flex flex-wrap items-baseline gap-2">
              <Link href={`/labels/${ref.id}`} className="font-mono text-sm font-medium underline">
                image {ref.id}
              </Link>
              <span className="text-xs text-zinc-500">
                {ref.gt.length} GT boxes · {ref.width}×{ref.height}
              </span>
              {set && (
                <span className="ml-auto rounded border border-zinc-300 bg-zinc-50 px-2 py-0.5 text-xs">
                  {set.state} · v{set.version} · {set.annotations.length} boxes
                </span>
              )}
            </div>
            {!set || set.annotations.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-500">
                No human annotations yet — open the editor to annotate this image.
              </p>
            ) : (
              <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div className="rounded border p-2">
                  <p className="text-xs text-zinc-500">Matched</p>
                  <p className="font-mono">{stats?.matched} / {stats?.units}</p>
                </div>
                <div className="rounded border p-2">
                  <p className="text-xs text-zinc-500">
                    Cohen&apos;s κ{" "}
                    <span className="rounded border border-amber-300 bg-amber-50 px-1 text-amber-700">
                      browser_approx
                    </span>
                  </p>
                  <p className="font-mono">{kappa(stats?.kappa ?? null)}</p>
                </div>
                <div className="rounded border p-2">
                  <p className="text-xs text-zinc-500">% agree</p>
                  <p className="font-mono">{((stats?.pct_agree ?? 0) * 100).toFixed(1)}%</p>
                </div>
                <div className="rounded border p-2">
                  <p className="text-xs text-zinc-500">Decisions</p>
                  <p className="font-mono">
                    {decisions.length ? decisions.map((d) => d.decision).join(", ") : "—"}
                  </p>
                </div>
              </div>
            )}
            {set?.state === "submitted" && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason (optional)"
                  className="min-w-48 flex-1 rounded border border-zinc-300 px-2 py-1.5 text-xs"
                />
                <button
                  type="button"
                  onClick={() => decide(ref.id, "approved")}
                  disabled={role === "user"}
                  title={role === "user" ? "Switch role to reviewer" : undefined}
                  className="rounded border border-emerald-500 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-800 disabled:opacity-40"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => decide(ref.id, "rejected")}
                  disabled={role === "user"}
                  title={role === "user" ? "Switch role to reviewer" : undefined}
                  className="rounded border border-red-400 bg-red-50 px-3 py-1.5 text-xs text-red-700 disabled:opacity-40"
                >
                  Reject
                </button>
              </div>
            )}
            {decisions.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-zinc-600">
                {decisions.map((d, i) => (
                  <li key={i} className="font-mono">
                    {d.decided_at.slice(0, 19).replace("T", " ")} · {d.reviewer_id} {d.decision}
                    {d.reason ? ` — ${d.reason}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
