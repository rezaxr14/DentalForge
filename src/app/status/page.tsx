import type { Metadata } from "next";
import { capabilities, tryGetEnv } from "@/shared/config/env";
import { FEATURES, FEATURE_KEYS, emptySnapshot, loadWorkerSnapshot, resolveFeature, type StrategyKind } from "@/features/capability";
import { PingJobPanel } from "@/features/jobs";
import { isDegradedStore, selectOrgStore } from "@/shared/db";
import { can } from "@/shared/domain/auth";
import { getActor } from "@/shared/jobs/deps";
import { getStorageAdapter } from "@/shared/jobs/deps";

export const metadata: Metadata = { title: "Status — TraceForge" };
export const dynamic = "force-dynamic";

const STRATEGY_STYLE: Record<StrategyKind, string> = {
  worker: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  browser: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  replay: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  heuristic: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  unavailable: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

async function load() {
  const parsed = tryGetEnv();
  if (!parsed.ok) return { ok: false as const, problems: parsed.problems };
  const env = parsed.env;
  const caps = capabilities(env);
  try {
    const store = await selectOrgStore();
    const dbUp = !isDegradedStore(store);
    const actor = dbUp ? await getActor() : null;
    const snap = await loadWorkerSnapshot(actor ? store.scoped(actor.orgId) : null, env.WORKER_MODE, dbUp);
    return { ok: true as const, env, caps, dbUp, actor, snap };
  } catch {
    return { ok: true as const, env, caps, dbUp: false, actor: null, snap: emptySnapshot(env.WORKER_MODE, false, "db-unavailable") };
  }
}

export default async function StatusPage() {
  const loaded = await load();
  if (!loaded.ok) {
    return (
      <main className="mx-auto max-w-3xl space-y-3 px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Misconfigured deployment</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          The server refused to start with an insecure or incomplete configuration. Fix these variables and redeploy:
        </p>
        <ul className="list-disc ps-5 text-sm">
          {loaded.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </main>
    );
  }
  const { env, caps, dbUp, actor, snap } = loaded;
  const dbLabel = !caps.db ? "not configured" : dbUp ? "connected" : "unreachable (in-memory fallback)";
  const canEnqueue = Boolean(actor && can(actor.role, "job.create")) && env.WORKER_MODE !== "off";

  return (
    <main className="mx-auto max-w-6xl space-y-8 px-6 py-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">System status</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
          Everything here is optional infrastructure. The app runs without a Python worker, Redis or object storage —
          each missing piece moves features down the ladder <em>worker → browser → replay → unavailable</em> instead of
          breaking them.
        </p>
      </header>

      <section aria-labelledby="svc">
        <h2 id="svc" className="mb-2 text-lg font-medium">Services</h2>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Database", dbLabel],
            ["Realtime", caps.redis ? "Redis configured" : "DB polling (no Redis)"],
            ["Object storage", getStorageAdapter().provider],
            ["Worker integration", env.WORKER_MODE],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg border border-border p-3">
              <dt className="text-xs uppercase tracking-wide text-zinc-500">{k}</dt>
              <dd className="mt-1 text-sm font-medium">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="wk">
        <h2 id="wk" className="mb-2 text-lg font-medium">Workers</h2>
        {snap.workers.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {snap.reason === "signed-out"
              ? "Sign in to see your organization's workers."
              : snap.reason === "integration-off"
                ? "Worker integration is off (WORKER_MODE=off)."
                : snap.reason === "db-unavailable"
                  ? "The database is unreachable, so worker state is unknown."
                  : "No worker has registered yet. Point one at /api/worker/v1 with a worker token (see docs/worker-contract.md)."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start text-sm">
              <thead className="text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="py-1 pe-4 text-start">Name</th>
                  <th className="pe-4 text-start">Runtime</th>
                  <th className="pe-4 text-start">Status</th>
                  <th className="pe-4 text-start">Last heartbeat</th>
                  <th className="text-start">Capabilities</th>
                </tr>
              </thead>
              <tbody>
                {snap.workers.map((w) => (
                  <tr key={w.id} className="border-t border-border">
                    <td className="py-1.5 pe-4 font-medium">{w.name}</td>
                    <td className="pe-4">{w.runtime}</td>
                    <td className="pe-4 capitalize">{w.status}</td>
                    <td className="pe-4">{w.lastHeartbeatAt ? new Date(w.lastHeartbeatAt).toLocaleString() : "never"}</td>
                    <td className="font-mono text-xs">{w.capabilities.join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="ladder">
        <h2 id="ladder" className="mb-2 text-lg font-medium">Capability ladder</h2>
        <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
          How each feature would run <strong>right now</strong>, resolved from live worker heartbeats.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="py-1 pe-4 text-start">Feature</th>
                <th className="pe-4 text-start">Runs as</th>
                <th className="text-start">Why</th>
              </tr>
            </thead>
            <tbody>
              {FEATURE_KEYS.map((f) => {
                const r = resolveFeature(f, snap);
                return (
                  <tr key={f} className="border-t border-border align-top">
                    <td className="py-2 pe-4">
                      <div className="font-medium">{FEATURES[f].label}</div>
                      <code className="text-xs text-zinc-500">{f}</code>
                    </td>
                    <td className="pe-4">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STRATEGY_STYLE[r.strategy]}`}>
                        {r.strategy}
                      </span>
                      {r.queueable && <div className="mt-1 text-xs text-zinc-500">can queue for later</div>}
                    </td>
                    <td className="text-zinc-700 dark:text-zinc-300">
                      {r.reason}
                      <div className="mt-0.5 text-xs text-zinc-500">{FEATURES[f].note}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="ping">
        <h2 id="ping" className="mb-2 text-lg font-medium">Pipeline check</h2>
        <PingJobPanel canEnqueue={canEnqueue} workerOnline={snap.status === "online"} />
      </section>
    </main>
  );
}
