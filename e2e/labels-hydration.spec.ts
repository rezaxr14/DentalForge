/**
 * Regression: LabelForge pages that show browser-local state (localStorage)
 * must hydrate cleanly for a RETURNING user.
 *
 * Found by the first browser run (M8-E): `/labels/queue`, `/labels/review` and
 * `/labels/export` read `localStorage` while rendering a client component, so the
 * server HTML (empty store) and the first client render (the user's real store)
 * disagreed → React error #418 and a forced client re-render. Unit tests cannot
 * see this (no hydration there), and a fresh browser profile never triggers it:
 * the store must already hold data before the page loads.
 */
import { expect, test, type Page } from "@playwright/test";
import { startApp, DEAD_DB, SECRETS, type RunningApp } from "./support/app";
import { watchPage } from "./support/page-watch";

const ann = (id: string, status: "approved" | "submitted") => ({
  id,
  bbox: [100, 120, 60, 80],
  fdi_quadrant: 1,
  fdi_position: 6,
  pathology: "Caries",
  source: "human",
  confidence: null,
  status,
  version: 1,
  author_id: "demo_user",
});

/** A realistic returning-user store: one submitted set (1 approved + 1 submitted box), one decision, reviewer role. */
const STORE = {
  sets: {
    "1": {
      image_id: "1",
      assignee_id: "demo_user",
      state: "submitted",
      version: 3,
      submitted_at: "2026-10-01T10:00:00.000Z",
      annotations: [ann("a1", "approved"), ann("a2", "submitted")],
    },
  },
  decisions: {
    "1": [{ annotation_set_id: "1", reviewer_id: "rev_1", decision: "approved", reason: "boxes match", decided_at: "2026-10-01T11:00:00.000Z" }],
  },
  roles: {},
};

async function seed(page: Page) {
  await page.addInitScript((store) => {
    window.localStorage.setItem("df.labels.v1", JSON.stringify(store));
    window.localStorage.setItem("df.role.v1", "reviewer");
  }, STORE);
}

test.describe("LabelForge hydrates cleanly with existing local state", () => {
  let app: RunningApp;
  test.beforeAll(async () => {
    // Fixture-backed pages: no database needed.
    app = await startApp({ ...SECRETS, DATABASE_URL: DEAD_DB, WORKER_MODE: "off" });
  });
  test.afterAll(async () => app.stop());

  test("/labels/queue shows the stored state, no hydration error", async ({ page }) => {
    await seed(page);
    const watch = watchPage(page, app.base);
    await page.goto(`${app.base}/labels/queue`);
    const row = page.getByRole("row", { name: /image 1/ });
    await expect(row).toContainText("submitted"); // client-only data really arrived
    await expect(row.getByRole("cell").nth(3)).toHaveText("2"); // "Your boxes"
    await page.waitForLoadState("networkidle");
    expect(watch.problems()).toEqual([]);
  });

  test("/labels/review shows the stored role, set and decision, no hydration error", async ({ page }) => {
    await seed(page);
    const watch = watchPage(page, app.base);
    await page.goto(`${app.base}/labels/review`);
    await expect(page.getByText("submitted · v3 · 2 boxes")).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve" })).toBeEnabled(); // reviewer role from storage
    await expect(page.getByText(/rev_1 approved — boxes match/)).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(watch.problems()).toEqual([]);
  });

  test("/labels/export counts the stored boxes, no hydration error", async ({ page }) => {
    await seed(page);
    const watch = watchPage(page, app.base);
    await page.goto(`${app.base}/labels/export`);
    const row = page.getByRole("row", { name: /image 1/ });
    await expect(row.getByRole("cell").nth(1)).toHaveText("1"); // approved-only default: 1 of the 2 boxes
    await page.getByLabel(/approved only/).uncheck();
    await expect(row.getByRole("cell").nth(1)).toHaveText("2");
    await page.waitForLoadState("networkidle");
    expect(watch.problems()).toEqual([]);
  });
});
