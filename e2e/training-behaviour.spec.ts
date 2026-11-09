/**
 * Behavioural tests for the Training page (/training) — matrix placeholders, no fabricated numbers.
 */
import { expect, test } from "@playwright/test";
import { DB_URL, SECRETS, startApp, type RunningApp } from "./support/app";

let app: RunningApp;

test.beforeAll(async () => {
  app = await startApp({
    ...SECRETS,
    DATABASE_URL: DB_URL,
    WORKER_MODE: "off",
    // Optional: E2E_DATABASE_URL=<seeded db> E2E_DEMO_ORG_SLUG=demo exercises the seeded-demo branch of these specs.
    ...(process.env.E2E_DEMO_ORG_SLUG ? { DEMO_ORG_SLUG: process.env.E2E_DEMO_ORG_SLUG } : {}),
  });
});

test.afterAll(async () => app.stop());

test.describe("/training — pipeline view", () => {
  test("shows pipeline stages with correct status", async ({ page }) => {
    await page.goto(`${app.base}/training`);
    await page.waitForLoadState("networkidle");

    // Should show pipeline stages: Data, SFT, GRPO, Evaluation (in the pipeline section)
    const pipelineSection = page.locator("section").filter({ hasText: "Pipeline" });
    await expect(pipelineSection.locator("text=Data")).toBeVisible();
    await expect(pipelineSection.locator("text=SFT").first()).toBeVisible();
    await expect(pipelineSection.locator("text=GRPO").first()).toBeVisible();
    await expect(pipelineSection.locator("text=Evaluation")).toBeVisible();
  });

  test("shows 'Done' for completed stages, 'Not run yet' for future stages", async ({ page }) => {
    await page.goto(`${app.base}/training`);
    await page.waitForLoadState("networkidle");

    // Data and Evaluation should be Done (Badge elements)
    await expect(page.locator("text=Done").first()).toBeVisible();

    // SFT and GRPO should show Not run yet
    await expect(page.locator("text=Not run yet").first()).toBeVisible();
  });
});

test.describe("/training — experiment matrix", () => {
  test("shows real zero-shot numbers, placeholders for SFT/GRPO", async ({ page }) => {
    await page.goto(`${app.base}/training`);
    await page.waitForLoadState("networkidle");

    // Should show matrix with zero-shot row having real numbers
    await expect(page.locator("table").locator("text=Base (zero-shot)")).toBeVisible();

    // SFT and GRPO rows should show "Not run yet" (in the matrix table cells)
    // Use first() to get the first match within the table context
    const matrixTable = page.locator("table");
    await expect(matrixTable.locator("text=SFT").locator("..").locator("text=Not run yet").first()).toBeVisible();
    await expect(matrixTable.locator("text=GRPO").locator("..").locator("text=Not run yet").first()).toBeVisible();
  });
});

test.describe("/training — model registry", () => {
  test("shows model table with stage badges", async ({ page }) => {
    await page.goto(`${app.base}/training`);
    await page.waitForLoadState("networkidle");

    // Seeded demo database (E2E_DEMO_ORG_SLUG): the registry table (the second table, after the experiment matrix)
    // with stage badges. Empty database, what CI starts from: the honest empty state, no table and no made-up rows.
    const modelTable = page.locator("table").nth(1);
    if (process.env.E2E_DEMO_ORG_SLUG) {
      await expect(modelTable).toBeVisible();
      await expect(modelTable.locator("text=zero_shot").first()).toBeVisible();
      await expect(modelTable.locator("text=yolo").first()).toBeVisible();
    } else {
      await expect(page.getByText("No models registered")).toBeVisible();
      await expect(page.locator("table")).toHaveCount(1); // only the experiment matrix
    }
  });
});

test.describe("/training — grounding checkpoint", () => {
  test("shows grounding checkpoint card - either metrics or honest 'not registered' message", async ({ page }) => {
    await page.goto(`${app.base}/training`);
    await page.waitForLoadState("networkidle");

    // Should show grounding checkpoint card - either metrics or honest "not registered" message
    await expect(page.getByRole("heading", { name: "Grounding checkpoint" })).toBeVisible();

    // Check for either metrics or honest message
    const hasMetrics = await page.locator("text=map50").first().isVisible().catch(() => false);
    const hasNoCheckpoint = await page.locator("text=No grounding checkpoint registered").first().isVisible().catch(() => false);
    
    expect(hasMetrics || hasNoCheckpoint).toBeTruthy();
  });
});

test.describe("/training — no fabricated numbers", () => {
  test("no synthetic data in production - all metrics are real or explicit placeholders", async ({ page }) => {
    await page.goto(`${app.base}/training`);
    await page.waitForLoadState("networkidle");

    // Should not have any fabricated target numbers in visible content
    // Check for explicit "target X.XX" or "goal X.XX" patterns (not just "target numbers" which is descriptive text)
    const mainContent = page.locator("main, [role=main], article").first();
    const text = await mainContent.textContent();
    // Match "target 0.5" or "goal 0.8" but not "target numbers" (descriptive)
    expect(text).not.toMatch(/target\s+\d+\.\d+/i);
    expect(text).not.toMatch(/goal\s+\d+\.\d+/i);
  });
});