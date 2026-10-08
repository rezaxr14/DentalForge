"use client";

/**
 * Org switcher (plan §5.2): lists the caller's organizations and switches
 * the Better Auth active org (`organization.setActive`). Renders nothing
 * when signed out or when the list is empty; degrades silently offline.
 */
import { useEffect, useState } from "react";
import { authClient } from "@/shared/auth/client";

interface Org {
  id: string;
  name: string;
  slug: string;
}

export function OrgSwitcher() {
  const { data: session, isPending } = authClient.useSession();
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    authClient.organization
      .list()
      .then((res) => {
        if (!cancelled && !res.error) setOrgs((res.data ?? []) as Org[]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session]);

  if (isPending || !session || orgs.length === 0) return null;
  const activeId = (session.session as { activeOrganizationId?: string | null }).activeOrganizationId;

  async function setActive(organizationId: string) {
    setSwitching(true);
    try {
      await authClient.organization.setActive({ organizationId });
      window.location.reload();
    } finally {
      setSwitching(false);
    }
  }

  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <span className="text-zinc-500">Org</span>
      <select
        aria-label="Active organization"
        value={activeId ?? ""}
        disabled={switching}
        onChange={(e) => {
          if (e.target.value) void setActive(e.target.value);
        }}
        className="rounded-md border border-input bg-card px-2 py-1 text-foreground"
      >
        {activeId === null || activeId === undefined || activeId === "" ? (
          <option value="">Select…</option>
        ) : null}
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}
