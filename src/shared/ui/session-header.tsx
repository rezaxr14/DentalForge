"use client";

/**
 * Session header: sign-in link when signed out, email + sign-out when in.
 * Client-side via `useSession` so the layout stays a server component and
 * the header never blocks first paint or fails offline.
 */
import Link from "next/link";
import { authClient } from "@/shared/auth/client";

export function SessionHeader() {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) return <span className="text-sm text-zinc-400">…</span>;
  if (!session) {
    return (
      <Link href="/sign-in" className="text-sm font-medium underline-offset-4 hover:underline">
        Sign in
      </Link>
    );
  }
  return (
    <span className="inline-flex items-center gap-3 text-sm">
      <span className="text-zinc-600">{session.user.email}</span>
      <button
        type="button"
        onClick={() => {
          void authClient.signOut().finally(() => window.location.reload());
        }}
        className="font-medium underline-offset-4 hover:underline"
      >
        Sign out
      </button>
    </span>
  );
}
