/**
 * M6 Better Auth integration — validates the Drizzle ↔ Better Auth contract
 * (table/modelName mapping, column names, role enum) against real Postgres.
 *
 * Skips itself entirely when Docker Postgres is not reachable so `pnpm ci`
 * stays green in environments without the dev database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { auth } from "@/shared/auth";
import { getEnv } from "@/shared/config/env";
import { getPgDb, getPool } from "@/shared/db/pg";
import { memberships } from "@/shared/db/schema";
import { eq } from "drizzle-orm";

const pool = new pg.Pool({ connectionString: getEnv().DATABASE_URL });
let dbUp = false;
try {
  const probe = await pool.query(
    "select current_database() as db, inet_server_addr() as addr, inet_server_port() as port, (select count(*) from information_schema.tables where table_schema='public') as tables",
  );
  console.log("[m6-auth] probe:", getEnv().DATABASE_URL, probe.rows[0]);
  dbUp = true;
} catch (err) {
  console.log("[m6-auth] probe failed:", getEnv().DATABASE_URL, err);
  dbUp = false;
}
await pool.end();

const suffix = Date.now().toString(36);
const ownerEmail = `m6-owner-${suffix}@test.local`;
const outsiderEmail = `m6-outsider-${suffix}@test.local`;
const password = "Str0ng-Passw0rd!";

let ownerToken = "";
let outsiderToken = "";
let orgId = "";
let invitationId = "";

describe.skipIf(!dbUp)("better auth + drizzle (docker postgres)", () => {
  beforeAll(async () => {
    // Initializing $context runs the adapter + Better Auth schema check.
    await auth.$context;
  }, 20_000);

  afterAll(async () => {
    // Org delete cascades memberships/invites; user rows cleaned explicitly.
    if (orgId) {
      try {
        await auth.api.deleteOrganization({
          body: { organizationId: orgId },
          headers: new Headers({ authorization: `Bearer ${ownerToken}` }),
        });
      } catch {
        // best effort — raw delete below still cleans up
      }
    }
    const client = new pg.Client({ connectionString: getEnv().DATABASE_URL });
    await client.connect();
    try {
      await client.query("DELETE FROM users WHERE email IN ($1, $2)", [
        ownerEmail,
        outsiderEmail,
      ]);
    } finally {
      await client.end();
    }
    await getPool().end().catch(() => undefined);
  });

  it("signs up users and issues session tokens", async () => {
    const owner = await auth.api.signUpEmail({
      body: { email: ownerEmail, password, name: "M6 Owner" },
    });
    expect(owner.token).toBeTruthy();
    ownerToken = owner.token ?? "";

    const outsider = await auth.api.signUpEmail({
      body: { email: outsiderEmail, password, name: "M6 Outsider" },
    });
    expect(outsider.token).toBeTruthy();
    outsiderToken = outsider.token ?? "";

    const session = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${ownerToken}` }),
    });
    expect(session?.user.email).toBe(ownerEmail);
  }, 20_000);

  it("creates an organization with an admin membership", async () => {
    const org = await auth.api.createOrganization({
      body: { name: `M6 Org ${suffix}`, slug: `m6-org-${suffix}` },
      headers: new Headers({ authorization: `Bearer ${ownerToken}` }),
    });
    expect(org.id).toBeTruthy();
    orgId = org.id;

    const db = getPgDb();
    const rows = await db
      .select()
      .from(memberships)
      .where(eq(memberships.organizationId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("admin");
    expect(rows[0]?.userId).toBeTruthy();
  }, 20_000);

  it("creates an invitation with a plan role", async () => {
    const invite = await auth.api.createInvitation({
      body: {
        email: outsiderEmail,
        role: "reviewer",
        organizationId: orgId,
      },
      headers: new Headers({ authorization: `Bearer ${ownerToken}` }),
    });
    invitationId = invite.id;
    expect(invite.id).toBeTruthy();
    expect(invite.role).toBe("reviewer");

    const db = getPgDb();
    const rows = await db
      .select()
      .from(memberships)
      .where(eq(memberships.organizationId, orgId));
    // Invited user must NOT be a member yet (invite ≠ membership).
    expect(rows).toHaveLength(1);
  }, 20_000);

  it("keeps organizations isolated per session", async () => {
    const list = await auth.api.listOrganizations({
      headers: new Headers({ authorization: `Bearer ${outsiderToken}` }),
    });
    expect(list).toHaveLength(0);

    const ownerList = await auth.api.listOrganizations({
      headers: new Headers({ authorization: `Bearer ${ownerToken}` }),
    });
    expect(ownerList.map((o) => o.id)).toContain(orgId);
  }, 20_000);

  it("cleans up the pending invitation", async () => {
    await auth.api.cancelInvitation({
      body: { invitationId },
      headers: new Headers({ authorization: `Bearer ${ownerToken}` }),
    });
    expect(invitationId).toBeTruthy();
  }, 20_000);
});
