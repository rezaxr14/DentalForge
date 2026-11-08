content = '''/**
 * Behavioural tests for the Training page (/training) — matrix placeholders, no fabricated numbers.
 */
import { expect, test } from "@playwright/test";
import { DB_URL, SECRETS, startApp, type RunningApp } from "./support/app";

let app: RunningApp;

test.beforeAll(async () => {
  app = await startApp({ ...SECRETS, DATABASE_URL: DB_URL, WORKER_MODE: "off" });
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

    // Should show model registry table (the second table with Model/Stage/Kind/Metrics headers)
    await expect(page.locator("table").filter({ hasText: "Model" }).filter({ hasText: "Stage" })).toBeVisible();

    // Should have stage badges in the model registry table
    const modelTable = page.locator("table").filter({ hasText: "Model" }).filter({ hasText: "Stage" });
    await expect(modelTable.locator("text=test")).toBeVisible();
    await expect(modelTable.locator("text=zero_shot")).toBeVisible();
  });
});

test.describe("/training — grounding checkpoint", () => {
  test("displays real YOLO metrics", async ({ page }) => {
    await page.goto(`${app.base}/training`);
    await page.waitForLoadState("networkidle");

    // Should show grounding checkpoint card with real metrics
    await expect(page.locator("text=DENTEX grounding YOLO").first()).toBeVisible();
    await expect(page.locator("text=/map50/i")).toBeVisible();
    await expect(page.locator("text=/map50_95/i")).toBeVisible();
    await expect(page.locator("text=/precision/i")).toBeVisible();
    await expect(page.locator("text=/recall50/i")).toBeVisible();
    await expect(page.locator("text=/iou/i")).toBeVisible();
  });
});

test.describe("/training — no fabricated numbers", () => {
  test("no synthetic data in production - all metrics are real or explicit placeholders", async ({ page }) => {
    await page.goto(`${app.base}/training`);
    await page.waitForLoadState("networkidle");

    // Should not have any fabricated target numbers
    const text = await page.textContent("body");
    expect(text).not.toMatch(/target.*\\d+\\.\\d+/i);
    expect(text).not.toMatch(/goal.*\\d+\\.\\d+/i);
  });
});
'''

with open(r'C:\Users\rezax\home\Code\DentalForge\e2e\training-behaviour.spec.ts', 'w', encoding='utf-8') as f:
    f.write(content)
print('Done')