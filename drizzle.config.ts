import { defineConfig } from "drizzle-kit";

/**
 * Dev targets local Docker Postgres (docker-compose.yml, port 5433);
 * prod Neon uses the same schema with `migrate` (plan §1, §7).
 *
 * Commands: `pnpm drizzle-kit generate` → SQL in `drizzle/`;
 *           `pnpm drizzle-kit push` applies directly (dev only).
 */
export default defineConfig({
  schema: "./src/shared/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://traceforge:traceforge@localhost:5433/traceforge",
  },
});
