"use client";

/**
 * Invite creator (admin-only): role + uses + TTL → signed link.
 * The server action re-checks `can("member.invite")`; non-admins get a
 * `forbidden` reason rendered here rather than the form hiding silently —
 * the UI hides controls with the same `can()` gate (plan §5.2).
 */
import { useState } from "react";
import { createInviteLink } from "@/shared/lib/invite-actions";

export function InviteCreator({ orgId, orgName }: { orgId: string; orgName: string }) {
  const [role, setRole] = useState("annotator");
  const [pending, setPending] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function mint() {
    setPending(true);
    setError(null);
    setLink(null);
    try {
      const res = await createInviteLink({ orgId, role: role as "admin" | "annotator" | "reviewer" });
      if (res.ok && res.link) {
        setLink(`${window.location.origin}${res.link}`);
      } else {
        setError(
          res.reason === "forbidden"
            ? "Only admins can create invite links."
            : res.reason === "signed-out"
              ? "Sign in first."
              : `Could not create link: ${res.reason ?? "unknown"}`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-zinc-500">
          Role{" "}
          <select
            aria-label={`Invite role for ${orgName}`}
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="rounded-md border border-input bg-card px-2 py-1 text-foreground"
          >
            <option value="annotator">annotator</option>
            <option value="reviewer">reviewer</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => void mint()}
          disabled={pending}
          className="rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create invite link"}
        </button>
      </div>
      {link ? (
        <p className="mt-2 break-all text-xs">
          <strong>Link (share within 72h, single use):</strong>{" "}
          <a href={link} className="underline">
            {link}
          </a>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}
