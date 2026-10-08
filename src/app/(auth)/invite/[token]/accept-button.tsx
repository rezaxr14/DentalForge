"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { acceptInviteLink } from "@/shared/lib/invite-actions";

/** Accept button: calls the server action, surfaces consumed/signed-out states. */
export function AcceptButton({ token }: { token: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; reason?: string } | null>(null);

  async function onAccept() {
    setPending(true);
    try {
      const res = await acceptInviteLink(token);
      setResult(res);
      if (res.ok) {
        router.push("/");
        router.refresh();
      }
    } catch (err) {
      setResult({ ok: false, reason: err instanceof Error ? err.message : "accept failed" });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={onAccept}
        disabled={pending}
        className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {pending ? "Accepting…" : "Accept invite"}
      </button>
      {result && !result.ok ? (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {result.reason === "signed-out"
            ? "Sign in first, then come back to this link."
            : result.reason === "consumed"
              ? "This link has already been used up. Ask an admin for a fresh one."
              : `Could not accept: ${result.reason}`}
        </p>
      ) : null}
    </div>
  );
}
