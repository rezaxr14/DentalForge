/**
 * Sign-in page (plan D7): email/password + optional GitHub/Google OAuth.
 * OAuth buttons render only when the provider is configured (env capability);
 * the DB-backed form degrades to a clear offline message when Postgres is
 * unreachable (plan §9 — the page itself never throws).
 */
import { SignInForm } from "./sign-in-form";
import { PageShell } from "@/shared/ui/page";

export default function SignInPage() {
  return (
    <PageShell size="narrow">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in to TraceForge</h1>
      <p className="mt-2 text-sm text-zinc-600">
        Members sign in with email or OAuth. Visitors join through a demo-org invite link — no anonymous
        guest login (plan D7).
      </p>
      <SignInForm />
    </PageShell>
  );
}
