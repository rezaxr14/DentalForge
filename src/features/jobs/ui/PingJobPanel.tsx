"use client";

/**
 * "Send a test job": enqueues a `system.ping` and watches it live. This is the
 * whole pipe (enqueue → claim → events → complete → SSE/polling) verified from
 * the UI with no GPU — and it shows honestly why it can't run (signed out,
 * integration off, no worker) instead of spinning forever.
 */
import { useState } from "react";
import { useJobStream } from "./useJobStream";

interface Problem {
  code?: string;
  title?: string;
  detail?: string;
}

export function PingJobPanel({ canEnqueue, workerOnline }: { canEnqueue: boolean; workerOnline: boolean }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const stream = useJobStream(jobId);

  async function send() {
    setBusy(true);
    setProblem(null);
    setJobId(null);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ type: "system.ping", payload: { message: "hello from the status page", steps: 3 } }),
      });
      const body = (await res.json()) as { id?: string } & Problem;
      if (res.ok && body.id) setJobId(body.id);
      else setProblem(body);
    } catch {
      setProblem({ title: "Network error", detail: "Could not reach the server." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || !canEnqueue}
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Sending…" : "Send test job"}
        </button>
        {!canEnqueue && <span className="text-sm text-zinc-500">Sign in as an organization member to enqueue jobs.</span>}
        {canEnqueue && !workerOnline && (
          <span className="text-sm text-zinc-500">No worker is online — the job will wait in the queue until one connects.</span>
        )}
      </div>

      {problem && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {problem.title ?? "Request failed"}
          {problem.detail ? ` — ${problem.detail}` : ""}
        </p>
      )}

      {jobId && (
        <div className="mt-3 text-sm" aria-live="polite">
          <p>
            Job <code className="text-xs">{jobId.slice(0, 8)}</code> — <strong>{stream.status}</strong>
            <span className="ms-2 text-xs text-zinc-500">via {stream.transport}</span>
          </p>
          <ol className="mt-2 space-y-1 font-mono text-xs text-zinc-600 dark:text-zinc-400">
            {stream.events.map((e) => (
              <li key={e.seq}>
                #{e.seq} {e.type} {JSON.stringify(e.data)}
              </li>
            ))}
          </ol>
          {stream.job?.status === "succeeded" && (
            <pre className="mt-2 overflow-x-auto rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-900">{JSON.stringify(stream.job.result, null, 2)}</pre>
          )}
          {stream.error && <p className="mt-2 text-xs text-amber-600">{stream.error}</p>}
        </div>
      )}
    </div>
  );
}
