"use client";

/**
 * Worker tokens (admin-only, M8 task B): create (token shown ONCE), list with
 * last-used, revoke. Authorization is re-checked server-side in every action;
 * the page only renders this for roles `can(role, "worker.listTokens")`.
 *
 * Timestamps are formatted deterministically (UTC, ISO-derived) so server and
 * client renders match — no locale/time-zone hydration drift.
 */
import { useId, useState, useTransition } from "react";
import { createWorkerTokenAction, revokeWorkerTokenAction } from "@/shared/lib/worker-token-actions";
import {
  MAX_ACTIVE_TOKENS,
  SCOPE_HELP,
  TOKEN_NAME_MAX,
  UI_TOKEN_SCOPES,
  type TokenScope,
  type WorkerTokenSummary,
} from "@/shared/jobs/token-types";

/** `2026-10-10T14:26:23.074Z` → `2026-10-10 14:26 UTC` */
export function formatUtc(iso: string | null): string {
  return iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "never";
}

export function WorkerTokenManager({
  orgId,
  orgName,
  initialTokens,
}: {
  orgId: string;
  orgName: string;
  initialTokens: WorkerTokenSummary[];
}) {
  const [tokens, setTokens] = useState(initialTokens);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<TokenScope>("jobs:write");
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const nameId = useId();
  const scopeId = useId();

  const active = tokens.filter((t) => !t.revokedAt);
  const revoked = tokens.filter((t) => t.revokedAt);

  function create() {
    setError(null);
    setCopied(false);
    startTransition(async () => {
      try {
        const res = await createWorkerTokenAction(orgId, { name, scope });
        if (res.ok) {
          setFresh({ name: res.created.name, token: res.token });
          setTokens(res.tokens);
          setName("");
        } else {
          setError(res.reason);
        }
      } catch {
        setError("Could not reach the server. Nothing was created.");
      }
    });
  }

  function revoke(id: string) {
    setError(null);
    setConfirming(null);
    startTransition(async () => {
      try {
        const res = await revokeWorkerTokenAction(orgId, id);
        if (res.ok) setTokens(res.tokens);
        else setError(res.reason);
      } catch {
        setError("Could not reach the server. Nothing was revoked.");
      }
    });
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false); // clipboard blocked: the token stays selectable in the box
    }
  }

  return (
    <div className="mt-3 border-t border-border pt-3" data-testid="worker-tokens">
      <h3 className="text-sm font-medium">Worker tokens</h3>
      <p className="mt-1 text-xs text-zinc-500">
        Bearer tokens let a worker (local GPU, Colab, Kaggle, cloud) poll {orgName} for jobs. Only a hash is
        stored, so a lost token cannot be recovered: revoke it and create another.
      </p>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor={nameId} className="block text-xs text-zinc-500">
            Name
          </label>
          <input
            id={nameId}
            value={name}
            maxLength={TOKEN_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. rtx4090-box"
            className="rounded-md border border-input bg-card px-2 py-1 text-xs text-foreground"
          />
        </div>
        <div>
          <label htmlFor={scopeId} className="block text-xs text-zinc-500">
            Scope
          </label>
          <select
            id={scopeId}
            value={scope}
            onChange={(e) => setScope(e.target.value as TokenScope)}
            className="rounded-md border border-input bg-card px-2 py-1 text-xs text-foreground"
          >
            {UI_TOKEN_SCOPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={create}
          disabled={pending || name.trim().length === 0 || active.length >= MAX_ACTIVE_TOKENS}
          className="rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-50"
        >
          {pending ? "Working…" : "Create token"}
        </button>
      </div>
      <p className="mt-1 text-xs text-zinc-500">{SCOPE_HELP[scope]}</p>

      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      ) : null}

      {fresh ? (
        <div
          role="status"
          className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
        >
          <p className="font-medium">Token “{fresh.name}” — copy it now. It will not be shown again.</p>
          <code className="mt-2 block break-all rounded bg-card p-2 font-mono text-foreground select-all">
            {fresh.token}
          </code>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => void copy(fresh.token)} className="rounded-md border px-2 py-1 font-medium">
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              onClick={() => {
                setFresh(null);
                setCopied(false);
              }}
              className="rounded-md border px-2 py-1 font-medium"
            >
              I’ve stored it
            </button>
          </div>
        </div>
      ) : null}

      {active.length === 0 ? (
        <p className="mt-3 text-xs text-zinc-500">No active tokens.</p>
      ) : (
        <ul className="mt-3 space-y-2" aria-label={`Active worker tokens for ${orgName}`}>
          {active.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-xs">
              <div>
                <span className="font-medium">{t.name}</span>{" "}
                <span className="rounded border px-1 text-zinc-500">{t.scope}</span>
                <div className="text-zinc-500">
                  Created {formatUtc(t.createdAt)} · Last used {formatUtc(t.lastUsedAt)}
                </div>
              </div>
              {confirming === t.id ? (
                <span className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => revoke(t.id)}
                    disabled={pending}
                    className="rounded-md border border-red-400 px-2 py-1 font-medium text-red-700 disabled:opacity-50 dark:text-red-300"
                  >
                    Confirm revoke
                  </button>
                  <button type="button" onClick={() => setConfirming(null)} className="rounded-md border px-2 py-1">
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(t.id)}
                  aria-label={`Revoke token ${t.name}`}
                  className="rounded-md border px-2 py-1 font-medium"
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {revoked.length > 0 ? (
        <details className="mt-3 text-xs text-zinc-500">
          <summary className="cursor-pointer">Revoked ({revoked.length})</summary>
          <ul className="mt-2 space-y-1">
            {revoked.map((t) => (
              <li key={t.id}>
                <span className="line-through">{t.name}</span> · {t.scope} · revoked {formatUtc(t.revokedAt)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
