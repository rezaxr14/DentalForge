/**
 * Degradation matrix in a REAL browser (plan §9.5). `pnpm smoke` proves the HTTP
 * level (status codes, no error text); this proves what a person sees: every page
 * of the production build, in five deployment shapes, loads without uncaught
 * exceptions, console errors, failed or 5xx requests, an error boundary, and with
 * the degraded state shown honestly rather than hidden.
 *
 *   A  database down, worker off          (Vercel, nothing attached yet)
 *   B  database down, worker live
 *   C  database up,   worker live, no worker has registered
 *   D  database up,   Redis configured but unreachable (polling in effect)
 *   E  database up,   object storage configured but not implemented (R2 stub throws)
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { DB_URL, DEAD_DB, SECRETS, startApp, type RunningApp } from "./support/app";
import { ERROR_BOUNDARY, watchPage } from "./support/page-watch";

function pagesUnder(dir: string, segs: string[] = []): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "api") continue;
      const isGroup = name.startsWith("(") && name.endsWith(")");
      out.push(...pagesUnder(p, isGroup ? segs : [...segs, name]));
    } else if (name === "page.tsx") {
      out.push("/" + segs.join("/"));
    }
  }
  return out.sort();
}
const PAGES = pagesUnder(join(process.cwd(), "src", "app"));

const R2_STUB = {
  STORAGE_PROVIDER: "r2",
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "bucket",
};

interface Variant {
  name: string;
  env: Record<string, string>;
  db: "up" | "down";
  redis: "absent" | "down";
  storage: "local" | "r2";
  workerMode: "off" | "live";
}

const VARIANTS: Variant[] = [
  { name: "A: DB down, worker off", env: { DATABASE_URL: DEAD_DB, WORKER_MODE: "off" }, db: "down", redis: "absent", storage: "local", workerMode: "off" },
  { name: "B: DB down, worker live", env: { DATABASE_URL: DEAD_DB, WORKER_MODE: "live" }, db: "down", redis: "absent", storage: "local", workerMode: "live" },
  { name: "C: DB up, worker live, none attached", env: { DATABASE_URL: DB_URL, WORKER_MODE: "live" }, db: "up", redis: "absent", storage: "local", workerMode: "live" },
  { name: "D: Redis unreachable", env: { DATABASE_URL: DB_URL, WORKER_MODE: "live", REDIS_URL: "redis://127.0.0.1:1" }, db: "up", redis: "down", storage: "local", workerMode: "live" },
  { name: "E: storage configured but failing", env: { DATABASE_URL: DB_URL, WORKER_MODE: "live", ...R2_STUB }, db: "up", redis: "absent", storage: "r2", workerMode: "live" },
];

async function sample(base: string, listing: string, prefix: string, fallback: string): Promise<string> {
  try {
    const html = await (await fetch(base + listing)).text();
    const m = new RegExp(`href="${prefix}/([^"/?#]+)"`).exec(html);
    const id = m?.[1];
    return id ? decodeURIComponent(id) : fallback;
  } catch {
    return fallback;
  }
}

for (const v of VARIANTS) {
  test.describe(`[${v.name}]`, () => {
    let app: RunningApp;
    let urls: Map<string, string>;

    test.beforeAll(async () => {
      app = await startApp({ ...SECRETS, ...v.env });
      const samples: Record<string, string> = {
        "/traces/[id]": await sample(app.base, "/traces", "/traces", "1"),
        "/evals/[id]": await sample(app.base, "/evals", "/evals", "1"),
        "/labels/[imageId]": "1",
        "/invite/[token]": "bogus-token",
      };
      urls = new Map(PAGES.map((r) => [r, r.replace(/\[\w+\]/, (m) => samples[r] ?? (m ? "1" : ""))]));
    });
    test.afterAll(async () => app.stop());

    for (const route of PAGES) {
      test(`${route} renders without console errors, failed requests or an error boundary`, async ({ page }) => {
        const url = urls.get(route)!;
        const watch = watchPage(page, app.base);
        const res = await page.goto(app.base + url, { waitUntil: "load" });
        await page.waitForLoadState("networkidle");

        const finalPath = new URL(page.url()).pathname;
        expect(res?.status(), `status for ${url}`).toBe(200);
        // A protected page may send a signed-out visitor to /sign-in; it must still be a working page.
        if (finalPath !== url) expect(finalPath).toBe("/sign-in");

        await expect(page.locator("h1").first()).toBeVisible();
        await expect(page.getByRole("link", { name: "Worker status and capabilities" })).toBeVisible();
        const body = await page.locator("body").innerText();
        for (const re of ERROR_BOUNDARY) expect(body, `body matched ${re}`).not.toMatch(re);
        expect(watch.problems()).toEqual([]);
      });
    }

    test("/api/health tells the truth about this shape", async ({ request }) => {
      const h = await (await request.get(`${app.base}/api/health`)).json();
      expect(h).toMatchObject({ db: v.db, redis: v.redis, storage: v.storage, workerMode: v.workerMode });
    });

    test("/status agrees with /api/health about the database and says what is degraded", async ({ page }) => {
      await page.goto(`${app.base}/status`);
      const row = (label: string) => page.locator("dt", { hasText: new RegExp(`^${label}$`, "i") }).locator("xpath=following-sibling::dd[1]");
      await expect(row("Database")).toHaveText(v.db === "up" ? "connected" : "unreachable (in-memory fallback)");
      await expect(row("Realtime")).toHaveText(v.redis === "down" ? "Redis unreachable — DB polling in effect" : "DB polling (no Redis)");
      await expect(row("Object storage")).toHaveText(v.storage);
      if (v.workerMode === "off") await expect(page.getByText("Worker integration is off")).toBeVisible();
    });

    test("LabelForge shows the replay fallback honestly when no worker is attached", async ({ page }) => {
      await page.goto(`${app.base}/labels/1`);
      await expect(page.getByText("Worker offline; showing precomputed results from stored artifacts.")).toBeVisible();
      await expect(page.getByText("import_replay").first()).toBeVisible();
      await expect(page.getByRole("button", { name: /Suggest boxes/ })).toBeVisible();
    });

    test("Tool Lab explains how each tool runs right now", async ({ page }) => {
      await page.goto(`${app.base}/tools`);
      for (const tool of ["fdi_label", "locate_tooth"]) {
        await page.getByRole("button", { name: tool, exact: true }).click();
        await expect(page.locator("[data-capability-reason]")).not.toBeEmpty();
      }
      // locate_tooth is the one tool with no in-browser port: with no worker it must say so, not spin or throw.
      await expect(page.getByText("locate_tooth is unavailable:")).toBeVisible();
    });
  });
}
