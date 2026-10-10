/**
 * `pnpm worker:token --org <slug> [--name <label>] [--scope jobs:write]`
 *
 * Mints a worker bearer token for an organization and prints it ONCE. Only the
 * SHA-256 is stored (plan §10), so a lost token cannot be recovered — revoke
 * it and mint another. Needs DATABASE_URL (the in-memory fallback has no
 * durable org to attach a token to).
 */
import { selectOrgStore, isDegradedStore } from "@/shared/db";
import { getPool } from "@/shared/db/pg";
import { mintWorkerToken } from "@/shared/jobs/tokens";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const slug = arg("org");
  const name = arg("name") ?? `worker-${new Date().toISOString().slice(0, 10)}`;
  const scope = (arg("scope") ?? "jobs:write") as "jobs:read" | "jobs:write" | "admin";
  if (!slug) {
    console.error("usage: pnpm worker:token --org <slug> [--name <label>] [--scope jobs:read|jobs:write|admin]");
    process.exit(2);
  }
  if (!["jobs:read", "jobs:write", "admin"].includes(scope)) {
    console.error(`unknown scope: ${scope}`);
    process.exit(2);
  }
  const store = await selectOrgStore();
  if (isDegradedStore(store)) {
    console.error("The database is unreachable (check DATABASE_URL). Tokens need a durable store.");
    process.exit(1);
  }
  const org = await store.getOrgBySlug(slug);
  if (!org) {
    console.error(`No organization with slug "${slug}".`);
    process.exit(1);
  }
  const { token, tokenHash } = mintWorkerToken();
  await store.scoped(org.id).createWorkerToken({ name, tokenHash, scopes: scope });
  console.log(`Worker token for "${org.name}" (${slug}), scope ${scope}, label "${name}":\n`);
  console.log(`  ${token}\n`);
  console.log("Shown once — only its hash is stored. Use it as:");
  console.log("  TRACEFORGE_URL=https://<your-app>  TRACEFORGE_TOKEN=<token>");
  await getPool().end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
