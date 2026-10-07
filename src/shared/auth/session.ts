import { headers } from "next/headers";
import { auth } from "./index";

/**
 * Session helper for RSC / server actions (plan §5.2 — every request is
 * scoped by the caller's active organization).
 */
export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}
