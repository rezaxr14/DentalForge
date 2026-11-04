import { defineConfig } from "drizzle-kit";

/**
 * Postgres everywhere: local Docker (docker-compose.yml) in development, Supabase
 * (managed) in production. The schema and the migrations in `drizzle/` are the same
 * on both, so nothing about the app changes when it moves.
 *
 * `DIRECT_URL` exists because Supabase's transaction pooler (port 6543) is what the
 * app should use, while DDL wants a session-mode connection (port 5432 on the same
 * pooler host, or the direct `db.<ref>.supabase.co` host). Set it only for
 * `db:migrate` / `db:push`; the app never reads it.
 *
 * Commands: `pnpm db:generate` writes SQL into `drizzle/`;
 *           `pnpm db:migrate` applies the committed migrations;
 *           `pnpm db:push` diffs straight to the database (dev only).
 */
export default defineConfig({
  schema: "./src/shared/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DIRECT_URL ??
      process.env.DATABASE_URL ??
      "postgresql://traceforge:traceforge@localhost:5433/traceforge",
  },
});
