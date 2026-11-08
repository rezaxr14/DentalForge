/**
 * Behavioural tests for the About Data page (/about-data) — licences and provenance.
 */
import { expect, test } from "@playwright/test";
import { DB_URL, SECRETS, startApp, type RunningApp } from "./support/app";

let app: RunningApp;

test.beforeAll(async () => {
  app = await startApp({ ...SECRETS, DATABASE_URL: DB_URL, WORKER_MODE: "off" });
});

test.afterAll(async () => app.stop());

test.describe("/about-data — licences", () => {
  test("shows DENTEX licence (CC BY-NC-SA 4.0)", async ({ page }) => {
    await page.goto(`${app.base}/about-data`);
    await page.waitForLoadState("networkidle");

    await expect(page.locator("h3", { hasText: "DENTEX — CC BY-NC-SA 4.0" })).toBeVisible();
  });

  test("shows YOLO licence (AGPL-3.0)", async ({ page }) => {
    await page.goto(`${app.base}/about-data`);
    await page.waitForLoadState("networkidle");

    await expect(page.locator("h3", { hasText: "Ultralytics YOLO — AGPL-3.0" })).toBeVisible();
  });

  test("shows citation for DENTEX paper", async ({ page }) => {
    await page.goto(`${app.base}/about-data`);
    await page.waitForLoadState("networkidle");

    await expect(page.locator("text=Hamamci et al., arXiv:2305.19112 (MICCAI 2023)")).toBeVisible();
  });
});

test.describe("/about-data — provenance", () => {
  test("shows demo bundle provenance (counts, build date)", async ({ page }) => {
    await page.goto(`${app.base}/about-data`);
    await page.waitForLoadState("networkidle");

    await expect(page.locator("h2", { hasText: "Bundle provenance" })).toBeVisible();
    await expect(page.locator("text=Source commit")).toBeVisible();
    await expect(page.locator("text=Built")).toBeVisible();
  });

  test("shows honest status: DENTEX-only, no Tufts data", async ({ page }) => {
    await page.goto(`${app.base}/about-data`);
    await page.waitForLoadState("networkidle");

    await expect(page.locator("text=Only DENTEX images are published")).toBeVisible();
    await expect(page.locator("text=Tufts data is never included")).toBeVisible();
  });

  test("shows VLM-DENTAL commit provenance", async ({ page }) => {
    await page.goto(`${app.base}/about-data`);
    await page.waitForLoadState("networkidle");

    await expect(page.locator("text=Source commit")).toBeVisible();
  });
});

test.describe("/about-data — honest status", () => {
  test("does not claim SFT/GRPO are done", async ({ page }) => {
    await page.goto(`${app.base}/about-data`);
    await page.waitForLoadState("networkidle");

    const text = await page.textContent("body");
    expect(text).not.toMatch(/SFT.*done/i);
    expect(text).not.toMatch(/GRPO.*done/i);
  });
});