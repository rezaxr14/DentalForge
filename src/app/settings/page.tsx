/**
 * Settings page (plan §11.9): org membership + invite links.
 * Server component: resolves the session + org list + caller roles once,
 * then renders the admin-gated invite creator per org. Degrades to a
 * signed-out/offline message instead of throwing (plan §9).
 */
import { headers } from "next/headers";
import { selectOrgStore } from "@/shared/db";
import { can, Role } from "@/shared/domain/auth";
import { listTokensForAdmin, type WorkerTokenSummary } from "@/shared/jobs/token-admin";
import { InviteCreator } from "./invite-creator";
import OrgFormClient from "./org-form-client";
import { WorkerTokenManager } from "./worker-tokens";
import { PageShell } from "@/shared/ui/page";

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  /** Caller role in this org (drives the admin-only invite UI). */
  role: string | null;
  /** Worker tokens, loaded only for roles that `can("worker.listTokens")`; null = not an admin / unavailable. */
  tokens: WorkerTokenSummary[] | null;
}

export default async function SettingsPage() {
  const h = await headers();
  // Lazy import: if the auth stack cannot initialise (misconfigured env), this page
  // must still render its signed-out message instead of failing to load (plan §9).
  let auth: (typeof import("@/shared/auth"))["auth"] | null = null;
  let session = null;
  try {
    auth = (await import("@/shared/auth")).auth;
    session = await auth.api.getSession({ headers: h });
  } catch {
    session = null;
  }
  if (!auth || !session) {
    return (
      <PageShell size="form">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-2 text-sm text-zinc-600">
          <a href="/sign-in" className="underline">
            Sign in
          </a>{" "}
          to manage organizations and invite links.
        </p>
      </PageShell>
    );
  }

  let orgs: OrgRow[] = [];
  let storeOk = true;
  try {
    const list = await auth.api.listOrganizations({ headers: h });
    const store = await selectOrgStore();
    orgs = await Promise.all(
      list.map(async (o) => {
        let role: string | null = null;
        try {
          role = (await store.membership(session.user.id, o.id))?.role ?? null;
        } catch {
          role = null;
        }
        const parsedRole = Role.safeParse(role);
        let tokens: WorkerTokenSummary[] | null = null;
        if (parsedRole.success && can(parsedRole.data, "worker.listTokens")) {
          const res = await listTokensForAdmin(store, session.user.id, o.id);
          tokens = res.ok ? res.tokens : null;
        }
        return { id: o.id, name: o.name, slug: o.slug ?? o.id, role, tokens };
      }),
    );
  } catch {
    storeOk = false;
  }

  return (
    <PageShell size="form">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-2 text-sm text-zinc-600">
        Signed in as <strong className="font-medium text-foreground">{session.user.email}</strong>.
      </p>
      {!storeOk ? (
        <p className="mt-4 rounded-lg border p-3 text-sm text-zinc-600">
          Database offline — membership and invite management are unavailable. Browsing stays in
          fixture mode.
        </p>
      ) : (
        <section className="mt-8 space-y-6">
          <div>
            <h2 className="text-lg font-medium">Organizations</h2>
            {orgs.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-600">
                No organizations yet. Create one below, or accept an invite link.
              </p>
            ) : (
              <ul className="mt-2 space-y-2">
                {orgs.map((o) => (
                  <li key={o.id} className="rounded-lg border p-3 text-sm">
                    <span className="font-medium">{o.name}</span>{" "}
                    <span className="text-zinc-500">({o.slug})</span>
                    <InviteCreator orgId={o.id} orgName={o.name} />
                    {o.tokens ? (
                      <WorkerTokenManager orgId={o.id} orgName={o.name} initialTokens={o.tokens} />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h2 className="text-lg font-medium">Create organization</h2>
            <OrgFormClient />
          </div>
        </section>
      )}
    </PageShell>
  );
}
