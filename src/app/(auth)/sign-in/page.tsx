/**
 * Sign-in page (plan D7): email/password + optional GitHub/Google OAuth.
 * OAuth buttons render only when the provider is configured (env capability);
 * the DB-backed form degrades to a clear offline message when Postgres is
 * unreachable (plan §9 — the page itself never throws).
 */
import { SignInForm } from "./sign-in-form";

export default function SignInPage() {
  return (
    <main className="mx-auto max-w-md px-6 py-16">
      <p className="mb-2 inline-block rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
        Research prototype, not for clinical use
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">Sign in to TraceForge</h1>
      <p className="mt-2 text-sm text-zinc-600">
        Members sign in with email or OAuth. Visitors join through a demo-org invite link — no anonymous
        guest login (plan D7).
      </p>
      <SignInForm />
    </main>
  );
}
