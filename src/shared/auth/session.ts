import { headers } from "next/headers";
import { auth } from "./index";

/**
 * Session helper for RSC / server actions (plan §5.2 — every request is
 * scoped by the caller's active organization).
 *
 * Returns null (never throws) when the database is unreachable so pages
 * degrade to their fixture/offline state instead of hitting error.tsx
 * (plan §9 — graceful degradation is a hard requirement).
 */
export async function getSession() {
  try {
    return await auth.api.getSession({ headers: await headers() });
  } catch {
    return null;
  }
}

/** Active org id for the current request, or null when signed out/offline. */
export async function getActiveOrgId(): Promise<string | null> {
  const session = await getSession();
  const orgId = session?.session.activeOrganizationId;
  return typeof orgId === "string" && orgId.length > 0 ? orgId : null;
}
