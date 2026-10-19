"use client";

import { useState } from "react";
import Link from "next/link";
import type { Annotation } from "@/shared/contracts/labels";
import { agreementStats } from "@/shared/domain/annotation";
import {
  applyDecision, getDecisions, getRole, resetAll, setRole,
} from "@/shared/lib/annotationStore";
import { useMounted } from "@/shared/ui/use-mounted";
import { useLabelSets } from "../use-label-sets";

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
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  // Sets come from the server when a session with an active organization exists, otherwise from this browser (never both).
  // Until that is decided the board renders what the server rendered (no sets); the browser store is only read after mount,
  // because reading it during the hydrating render would differ from the server HTML for a returning user (React #418).
  const ls = useLabelSets();
  const server = ls.phase === "server";
  const mounted = useMounted();
  const role: "user" | "reviewer" | "admin" = ls.viewer
    ? ls.viewer.role === "annotator" ? "user" : ls.viewer.role
    : ls.phase === "local" && mounted ? getRole() : "user";
  const switchRole = (r: "user" | "reviewer" | "admin"): void => {
    setRole(r);
    setTick((t) => t + 1);
  };

  const decide = async (imageId: string, decision: "approved" | "rejected"): Promise<void> => {
    if (server) {
      const r = await ls.transition(imageId, decision === "approved" ? "approve" : "reject", reason);
      switch (r.kind) {
        case "ok":
          setReason("");
          setMsg(`image ${imageId}: ${decision}.`);
          break;
        case "conflict":
          setMsg(`image ${imageId}: someone changed this set first; the list was refreshed.`);
          break;
        case "forbidden":
        case "invalid":
          setMsg(r.message);
          break;
        case "unauthorized":
          setMsg("You were signed out. Reload to continue with this browser's drafts.");
          break;
        case "notFound":
          setMsg(`image ${imageId}: not opened on the server.`);
          break;
        case "unavailable":
          setMsg(`The server did not answer (${r.message}). Try again.`);
          break;
      }
      return;
    }
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
      {ls.phase !== "loading" && (
        <p className="max-w-3xl text-sm text-zinc-600" data-review-source={ls.phase}>
          {server
            ? "Signed in: this board reads your organization's sets from the server. Decisions are recorded there with an audit entry, and the server refuses a decision on a set you drew boxes on."
            : `${ls.localReason === "server-unavailable" ? "The server could not be reached" : "You are not signed in, or no organization is selected"}, so this board shows the drafts kept in this browser. Decisions are recorded in this browser only (ADR-0005 §4) and the role switcher below is a demo stand-in.`}
        </p>
      )}
      {server && ls.viewer && (
        <p className="text-xs text-zinc-600" data-viewer>
          Signed in as <span className="font-mono">{ls.viewer.userId.slice(0, 8)}</span> · {ls.viewer.role}
          {role === "user" ? " · only reviewers and admins can decide" : ""}
        </p>
      )}
      {ls.phase === "local" && (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-zinc-600">Demo role:</span>
        {(["user", "reviewer", "admin"] as const).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => switchRole(r)}
            className={`rounded border px-2 py-1 ${
              role === r ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-300 dark:border-border bg-white dark:bg-card"
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
          className="ml-auto rounded border border-zinc-300 dark:border-border bg-white dark:bg-card px-2 py-1 text-zinc-600"
        >
          Reset local state
        </button>
      </div>
      )}
      {msg && <p className="text-sm text-zinc-700 dark:text-zinc-300">{msg}</p>}

      {refs.map((ref) => {
        const set = ls.getSet(ref.id);
        const stats = set
          ? agreementStats(ref.id, set.assignee_id, "gt_import", set.annotations, ref.gt)
          : null;
        const decisions = ls.phase === "local" && mounted ? getDecisions(ref.id) : [];
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
                <span className="ml-auto rounded border border-zinc-300 dark:border-border bg-zinc-50 dark:bg-muted px-2 py-0.5 text-xs">
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
                    {server
                      ? set.state === "approved" || set.state === "rejected" ? set.state : "—" // the server keeps the history in its audit log
                      : decisions.length ? decisions.map((d) => d.decision).join(", ") : "—"}
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
                  className="min-w-48 flex-1 rounded border border-zinc-300 dark:border-border px-2 py-1.5 text-xs"
                />
                <button
                  type="button"
                  onClick={() => void decide(ref.id, "approved")}
                  disabled={role === "user"}
                  title={role === "user" ? (server ? "Only reviewers and admins can decide" : "Switch role to reviewer") : undefined}
                  className="rounded border border-emerald-500 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-800 disabled:opacity-40"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => void decide(ref.id, "rejected")}
                  disabled={role === "user"}
                  title={role === "user" ? (server ? "Only reviewers and admins can decide" : "Switch role to reviewer") : undefined}
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
