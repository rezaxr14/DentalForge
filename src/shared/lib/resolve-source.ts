/**
 * Source resolution (M7): pick the DataSource pages read from.
 *
 * Default: fixtures (graceful degradation, plan section 9 — the app boots
 * with zero services). When `TRACEFORGE_DATASOURCE=postgres`, resolve the
 * caller's membership to an org id and return the Postgres-backed source;
 * any failure (no session, no membership, DB unreachable) falls back to
 * fixtures so a page never throws (plan section 9.4 rule 2).
 */
import { headers } from "next/headers";
import { auth } from "@/shared/auth";
import { getPgDb } from "@/shared/db/pg";
import { DrizzleOrgStore } from "@/shared/db/repositories";
import {
  fixtureSource,
  postgresSource,
  type DataSource,
} from "./datasource";

export type SourceResolution = {
  source: DataSource;
  /** Why the fixture source was chosen — shown as a UI badge. */
  fallbackReason: string | null;
};

async function resolveOrgId(): Promise<string | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;
  if (!userId) return null;
  const slug = process.env.IMPORT_ORG_SLUG ?? "demo";
  const store = new DrizzleOrgStore(getPgDb());
  const org = await store.getOrgBySlug(slug);
  if (!org) return null;
  const m = await store.membership(userId, org.id);
  return m ? org.id : null;
}

export async function resolveDataSource(): Promise<SourceResolution> {
  if (process.env.TRACEFORGE_DATASOURCE !== "postgres") {
    return { source: fixtureSource(), fallbackReason: null };
  }
  try {
    const orgId = await resolveOrgId();
    if (!orgId) {
      return {
        source: fixtureSource(),
        fallbackReason: "no membership in the imported org — showing fixture data",
      };
    }
    return { source: postgresSource(getPgDb(), orgId), fallbackReason: null };
  } catch {
    return {
      source: fixtureSource(),
      fallbackReason: "database unreachable — showing fixture data",
    };
  }
}
