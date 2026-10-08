/**
 * Invite acceptance page (plan D7): `/invite/<token>`.
 * Server-verifies the signature + expiry before rendering so bad/expired
 * links explain themselves without a round trip; the accept button calls
 * the `acceptInviteLink` server action (requires sign-in).
 */
import Link from "next/link";
import { verifyInvite } from "@/shared/lib/invites";
import { getEnv } from "@/shared/config/env";
import { AcceptButton } from "./accept-button";

const REASONS: Record<string, string> = {
  "bad-prefix": "This link is malformed.",
  "bad-format": "This link is malformed.",
  "bad-signature": "This link has been tampered with or was minted with a different secret.",
  "bad-payload": "This link is malformed.",
  "bad-claims": "This link carries invalid claims.",
  expired: "This link has expired. Ask an admin for a fresh one.",
};

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let verified;
  try {
    verified = verifyInvite(token, getEnv().INVITE_SIGNING_SECRET);
  } catch {
    verified = { ok: false as const, reason: "bad-payload" };
  }

  return (
    <main className="mx-auto max-w-md px-6 py-16">
      <p className="mb-2 inline-block rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
        Research prototype, not for clinical use
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">Organization invite</h1>
      {!verified.ok ? (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {REASONS[verified.reason] ?? "This invite link is not valid."}
        </div>
      ) : (
        <div className="mt-6 rounded-lg border p-4">
          <p className="text-sm text-zinc-600">
            You&apos;ve been invited as{" "}
            <strong className="font-medium text-foreground">{verified.claims.role}</strong>. Accepting
            grants you access to that organization&apos;s traces, evals and annotation work.
          </p>
          <AcceptButton token={token} />
          <p className="mt-3 text-xs text-zinc-500">
            You need an account first — <Link href="/sign-in" className="underline">sign in</Link>,
            then come back to this link.
          </p>
        </div>
      )}
    </main>
  );
}
