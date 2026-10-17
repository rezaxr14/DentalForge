"use client";

import { useSyncExternalStore } from "react";
import type { SyncView } from "@/shared/labels/sync-engine";

type Tone = "ok" | "info" | "warn" | "bad";

const TONE: Record<Tone, string> = {
  ok: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  info: "border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-border dark:bg-muted dark:text-zinc-300",
  warn: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
  bad: "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200",
};

export interface SyncDescription {
  tone: Tone;
  /** The short label in the badge. */
  text: string;
  /** One more line of explanation, shown under the toolbar. */
  detail: string | null;
}

/** What the user is told about where their boxes live. Pure: the wording is unit-tested. */
export function describeSync(view: SyncView | null): SyncDescription {
  if (!view || view.mode === "connecting" || view.status === "loading") {
    return { tone: "info", text: "Connecting…", detail: null };
  }
  if (view.mode === "local") {
    const detail: Record<NonNullable<SyncView["localReason"]>, string> = {
      "signed-out": "You are not signed in, or no organization is selected, so boxes are kept in this browser only. Sign in and select an organization to save them to the server.",
      "server-unavailable": "The server could not be reached, so boxes are kept in this browser only. Reload to try the server again.",
      forbidden: view.message ?? "Your role cannot open images on the server, so boxes are kept in this browser only.",
      "session-lost": "You were signed out. Your edits are kept in this browser; sign in again and reload to continue on the server.",
    };
    return { tone: "warn", text: "Saved in this browser only", detail: detail[view.localReason ?? "server-unavailable"] };
  }
  switch (view.status) {
    case "saved":
      return { tone: "ok", text: "Saved to server", detail: null };
    case "merged":
      return { tone: "ok", text: "Saved · merged with others' changes", detail: "Someone else edited this image at the same time; their changes and yours are both kept." };
    case "pending":
      return { tone: "info", text: "Unsaved changes", detail: null };
    case "saving":
      return { tone: "info", text: "Saving…", detail: null };
    case "retrying":
      return { tone: "warn", text: "Offline · will retry", detail: `${view.message ?? "The server did not answer"}. Your edits are kept in this page and sent as soon as the server answers; do not close it yet.` };
    case "error":
      return { tone: "bad", text: "Not saved", detail: view.message ?? "The server refused the latest edit." };
    case "readonly":
      return { tone: "info", text: view.state === "draft" ? "Read-only" : `Read-only · ${view.state}`, detail: view.message ?? `This set is ${view.state}, so it can no longer be edited.` };
    default:
      return { tone: "info", text: "…", detail: null };
  }
}

const tick = (cb: () => void) => {
  const id = setInterval(cb, 1000);
  return () => clearInterval(id);
};
/** Whole seconds; `0` on the server so the first client render matches the server HTML. */
function useSeconds(): number {
  return useSyncExternalStore(tick, () => Math.floor(Date.now() / 1000), () => 0);
}

function RetryIn({ retryAt }: { retryAt: number }) {
  const nowSec = useSeconds();
  const left = nowSec === 0 ? null : Math.max(0, Math.ceil(retryAt / 1000 - nowSec));
  return <span> · {left === null ? "retrying soon" : `retry in ${left}s`}</span>;
}

export function SyncBadge({ view }: { view: SyncView | null }) {
  const d = describeSync(view);
  return (
    <span
      role="status"
      aria-live="polite"
      data-sync-mode={view?.mode ?? "connecting"}
      data-sync-status={view?.status ?? "loading"}
      className={`rounded border px-2 py-1 font-medium ${TONE[d.tone]}`}
    >
      {d.text}
      {view?.mode === "server" && view.status === "retrying" && view.retryAt !== null && <RetryIn retryAt={view.retryAt} />}
    </span>
  );
}
