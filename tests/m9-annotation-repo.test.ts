/**
 * M9 slice 2 (ADR-0019): the annotation-set repository, one suite, two stores.
 * The Postgres run fails instead of skipping under CI=1, same rule as m6-repos.test.ts.
 */
import pg from "pg";
import { getEnv } from "@/shared/config/env";
import { getPgDb } from "@/shared/db/pg";
import { MemoryStore } from "@/shared/db/memory";
import { DrizzleOrgStore } from "@/shared/db/repositories";
import { defineAnnotationRepoSuite } from "./helpers/annotation-repo-suite";

const pool = new pg.Pool({ connectionString: getEnv().DATABASE_URL });
let dbUp = false;
try {
  await pool.query("SELECT 1");
  dbUp = true;
} catch {
  dbUp = false;
}
await pool.end();

if (!dbUp && process.env.CI) {
  throw new Error(
    `[m9-annotation-repo] CI requires Postgres but the probe of ${getEnv().DATABASE_URL} failed; ` +
      "the SQL half of the shared annotation suite must run on every CI push, not be skipped.",
  );
}

defineAnnotationRepoSuite("memory", async () => new MemoryStore());
defineAnnotationRepoSuite("drizzle", async () => new DrizzleOrgStore(getPgDb()), { skip: !dbUp });
