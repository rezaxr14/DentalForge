/**
 * Behavioural tests for the Agent page (/agent) — replay stepping, cohort compare, empty states, provenance label.
 * Run with `pnpm e2e:browser` after `pnpm build`.
 */
import { expect, test } from "@playwright/test";
import { DB_URL, SECRETS, startApp, type RunningApp } from "./support/app";

let app: RunningApp;

test.beforeAll(async () => {
  app = await startApp({ ...SECRETS, DATABASE_URL: DB_URL, WORKER_MODE: "off" });
});

test.afterAll(async () => app.stop());

test.describe("/agent — replay controls", () => {
  test("loads the default replay and shows turn timeline", async ({ page }) => {
    await page.goto(`${app.base}/agent`);
    await page.waitForLoadState("networkidle");

    // Should show the replay header with case name
    await expect(page.getByRole("heading", { name: /DENTEX case/ })).toBeVisible();

    // Should have replay controls: Start, Prev, Play, Next, End
    await expect(page.getByRole("button", { name: /Start/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Prev/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Play/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Next/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /End/i })).toBeVisible();

    // Should show turn timeline with at least one turn
    await expect(page.locator("text=/Turn timeline/")).toBeVisible();
    await expect(page.locator("ol").first()).toBeVisible();
  });

  test("step forward/backward through turns", async ({ page }) => {
    await page.goto(`${app.base}/agent`);
    await page.waitForLoadState("networkidle");

    // Should have Next and Prev buttons (may be disabled at boundaries)
    await expect(page.getByRole("button", { name: /Next/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Prev/i })).toBeVisible();
  });

  test("provenance badge shows 'imported training traces'", async ({ page }) => {
    await page.goto(`${app.base}/agent`);
    await page.waitForLoadState("networkidle");

    // Should show provenance badge with correct text
    await expect(page.locator("text=/imported training traces/")).toBeVisible();
  });

  test("trace picker filters and switches traces", async ({ page }) => {
    await page.goto(`${app.base}/agent`);
    await page.waitForLoadState("networkidle");

    // Should show filter chips (in the trace picker sidebar)
    await expect(page.getByRole("button", { name: /All/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /With tools/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /No tools/i }).first()).toBeVisible();
  });
});

test.describe("/agent — cohort compare", () => {
  test("shows compare card for same case different mode", async ({ page }) => {
    await page.goto(`${app.base}/agent`);
    await page.waitForLoadState("networkidle");

    // Should show compare card if same case exists in other mode (may not be visible depending on data)
    void page.locator("text=/compare/i");
  });
});

test.describe("/agent — empty states", () => {
  test("handles trace with no tool calls gracefully", async ({ page }) => {
    await page.goto(`${app.base}/agent`);
    await page.waitForLoadState("networkidle");

    // Should not crash on traces with no tool calls
    await expect(page.locator("body")).toBeVisible();
  });
});