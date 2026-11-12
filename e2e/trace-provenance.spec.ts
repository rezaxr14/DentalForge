/**
 * Provenance on the trace surfaces: the list and the detail page must say, in
 * plain words, that these are teacher-generated SFT training traces and not a
 * trained model's performance. The badge wording is asserted separately because
 * "passed trace verification" is easy to read as "clinically validated".
 *
 * The list is honest in two states: with traces (CI's seeded demo) and empty
 * (CI's browser job starts from an empty database), so each test asserts the
 * contract for the state it finds rather than skipping one of them.
 */
import { expect, test } from "@playwright/test";
import { DB_URL, SECRETS, startApp, type RunningApp } from "./support/app";

let app: RunningApp;

test.beforeAll(async () => {
  app = await startApp({
    ...SECRETS,
    DATABASE_URL: DB_URL,
    WORKER_MODE: "off",
    ...(process.env.E2E_DEMO_ORG_SLUG ? { DEMO_ORG_SLUG: process.env.E2E_DEMO_ORG_SLUG } : {}),
  });
});

test.afterAll(async () => app.stop());

test.describe("/traces — provenance", () => {
  test("states the traces are teacher-generated SFT data, not model performance", async ({ page }) => {
    await page.goto(`${app.base}/traces`);
    await page.waitForLoadState("networkidle");

    const text = await page.textContent("body");
    expect(text).toMatch(/teacher-generated SFT training traces/i);
    expect(text).toMatch(/performance numbers live on \/evals/i);
  });

  test("the verified badge reads 'passed trace verification', never 'clinically' anything", async ({ page }) => {
    await page.goto(`${app.base}/traces`);
    await page.waitForLoadState("networkidle");

    const text = (await page.textContent("body")) ?? "";
    expect(text).not.toMatch(/clinically (validated|verified|approved)/i);
    // An empty database has no badges to show; the page must say so instead.
    if (await page.locator('a[href^="/traces/"]').first().isVisible().catch(() => false)) {
      expect(text).toMatch(/passed trace verification/i);
    } else {
      expect(text).toMatch(/no traces|nothing here yet|empty/i);
    }
  });

  test("a trace detail page repeats the provenance and explains verification", async ({ page }) => {
    await page.goto(`${app.base}/traces`);
    await page.waitForLoadState("networkidle");
    const href = await page.locator('a[href^="/traces/"]').first().getAttribute("href").catch(() => null);
    if (!href) {
      // Empty database: the list must be an honest empty state, not a fake trace.
      expect(await page.textContent("body")).toMatch(/no traces|nothing here yet|empty/i);
      return;
    }

    await page.goto(`${app.base}${href}`);
    await page.waitForLoadState("networkidle");

    const text = await page.textContent("body");
    expect(text).toMatch(/teacher-generated SFT training traces/i);
    expect(text).toMatch(/passed trace verification|unverified/i);
  });
});
