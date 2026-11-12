/**
 * `pnpm demo:seed` must be idempotent: two runs leave exactly one row per bundle item.
 *
 * Opt-in (`DEMO_SEED_IDEMPOTENCY=1`) because it mutates the demo org and is run as its
 * own CI step, after `drizzle-kit push`, rather than alongside the parallel unit tests.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

const enabled = process.env.DEMO_SEED_IDEMPOTENCY === "1";
const url = process.env.DATABASE_URL;
const bundle = JSON.parse(readFileSync(join(process.cwd(), "demo", "bundle.json"), "utf8")) as {
  images: { split: string }[];
  traces: unknown[];
  evals: unknown[];
  models: unknown[];
};

type Counts = { images: number; traces: number; evalRuns: number; models: number };

async function demoCounts(): Promise<Counts> {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const { rows } = await pool.query<Counts>(`
      select
        (select count(*)::int from images i join organizations o on o.id = i.org_id where o.slug = 'demo') as images,
        (select count(*)::int from traces t join organizations o on o.id = t.org_id where o.slug = 'demo') as traces,
        (select count(*)::int from eval_runs e join organizations o on o.id = e.org_id where o.slug = 'demo') as "evalRuns",
        (select count(*)::int from model_registry m join organizations o on o.id = m.org_id where o.slug = 'demo') as models
    `);
    const row = rows[0];
    if (!row) throw new Error("count query returned no row");
    return row;
  } finally {
    await pool.end();
  }
}

describe.skipIf(!enabled || !url)("demo:seed is idempotent", () => {
  it("two runs give identical counts and match the bundle", async () => {
    execSync("pnpm demo:seed", { stdio: "pipe", env: process.env });
    const first = await demoCounts();
    execSync("pnpm demo:seed", { stdio: "pipe", env: process.env });
    const second = await demoCounts();

    expect(second).toEqual(first);
    expect(second).toEqual({
      // The seed stores train images only; validation images back eval cases.
      images: bundle.images.filter((i) => i.split === "train").length,
      traces: bundle.traces.length,
      evalRuns: bundle.evals.length,
      models: bundle.models.length,
    });
  }, 180_000);
});
