/**
 * The windowed box table (ADR-0021): with many boxes only the rows in view exist in the DOM, the table still announces its
 * full size and positions to assistive technology, and selecting a box anywhere (image, keyboard, table) scrolls its row in.
 * Real session, 120 boxes seeded through the API, production build.
 */
import { expect, test, type Page } from "@playwright/test";
import { DB_URL, SECRETS, startApp, type RunningApp } from "./support/app";
import { watchPage } from "./support/page-watch";

const N = 120;
let app: RunningApp;
test.beforeAll(async () => {
  app = await startApp({ ...SECRETS, DATABASE_URL: DB_URL, WORKER_MODE: "off" });
});
test.afterAll(async () => app.stop());

const headers = () => ({ origin: app.base });
const rowsInDom = (page: Page) => page.getByRole("table").getByRole("row").filter({ has: page.getByRole("button", { name: /^Select box/ }) });

test("120 boxes: the table is windowed, stays accessible, follows the selection and edits through to the server", async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: app.base });
  const uid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const email = `table-${uid}@example.com`;
  let su = await ctx.request.post(`${app.base}/api/auth/sign-up/email`, { data: { email, password: "browser-e2e-pass-123", name: "Table" }, headers: headers() });
  for (let i = 0; su.status() === 429 && i < 3; i++) {
    await new Promise((r) => setTimeout(r, (Number(su.headers()["x-retry-after"] ?? "11") + 1) * 1000));
    su = await ctx.request.post(`${app.base}/api/auth/sign-up/email`, { data: { email, password: "browser-e2e-pass-123", name: "Table" }, headers: headers() });
  }
  expect(su.ok()).toBe(true);
  expect((await ctx.request.post(`${app.base}/api/auth/organization/create`, { headers: headers(), data: { name: `Tbl ${uid}`, slug: `tbl-${uid}` } })).ok()).toBe(true);
  const opened = (await (await ctx.request.post(`${app.base}/api/labels/1/open`, { headers: headers(), data: {} })).json()) as { viewer: { userId: string } };
  const box = (i: number) => ({
    id: `t${i}`, bbox: [60 + (i % 25) * 105, 60 + Math.floor(i / 25) * 60, 95, 50], fdi_quadrant: 1 + (i % 4), fdi_position: 1 + (i % 8),
    pathology: "Caries", source: "human", confidence: null, status: "draft", version: 1, author_id: opened.viewer.userId,
  });
  const ops = await ctx.request.post(`${app.base}/api/labels/1/ops`, { headers: headers(), data: { baseVersion: 1, ops: Array.from({ length: N }, (_, i) => ({ type: "create", annotation: box(i), index: i })) } });
  expect(ops.ok(), "seed").toBe(true);

  const page = await ctx.newPage();
  const watch = watchPage(page, app.base);
  await page.goto(`${app.base}/labels/1`);
  await expect(page.locator("[data-sync-status=saved]")).toBeVisible({ timeout: 30_000 });
  const table = page.getByRole("table");

  // announced in full, rendered in part
  await expect(table).toHaveAttribute("aria-rowcount", String(N + 1));
  const rendered = await rowsInDom(page).count();
  expect(rendered, "only the window is in the DOM").toBeLessThan(25);
  expect(rendered).toBeGreaterThanOrEqual(10);
  await expect(page.getByRole("row", { name: /Select box 1\b/ }).first()).toHaveAttribute("aria-rowindex", "2");
  const dom = await page.evaluate(() => document.getElementsByTagName("*").length);
  expect(dom, "the page is far below the 5-6k nodes a fully rendered 120-row table adds").toBeLessThan(2500);

  // selecting a box on the image far down the list brings its row into the window
  const target = page.locator('[data-box-id="t100"]');
  await target.scrollIntoViewIfNeeded();
  await target.click();
  const row = page.getByRole("row", { name: /Select box 101\b/ });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("aria-current", "true");
  await expect(row).toHaveAttribute("aria-rowindex", "102");
  await expect(rowsInDom(page)).not.toHaveCount(N);

  // scrolling the table to the end reaches the last row; it can be selected and edited there
  await table.evaluate((t) => { (t.parentElement as HTMLElement).scrollTop = 1e6; });
  const last = page.getByRole("row", { name: new RegExp(`Select box ${N}\\b`) });
  await expect(last).toBeVisible();
  await expect(last).toHaveAttribute("aria-rowindex", String(N + 1));
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/labels/1/ops") && r.status() === 200);
  await last.getByRole("combobox", { name: `Pathology for box ${N}`, exact: true }).selectOption("Impacted");
  await saved;
  const set = (await (await ctx.request.get(`${app.base}/api/labels/1`)).json()) as { annotations: { id: string; pathology: string }[] };
  expect(set.annotations.find((a) => a.id === `t${N - 1}`)?.pathology).toBe("Impacted");
  expect(set.annotations.filter((a) => a.pathology === "Impacted")).toHaveLength(1);

  // the JSON view is capped and says so; the copy button builds the whole document on demand
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: app.base });
  const json = page.getByRole("region", { name: "Annotation set as JSON" });
  await expect(json).toContainText(`"annotations_not_shown": ${N - 25}`);
  await expect(json).not.toContainText('"id": "t60"');
  await page.getByRole("button", { name: "Copy full JSON" }).click();
  await expect(page.getByText(`Copied the full set JSON (${N} boxes).`)).toBeVisible();
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText())) as { annotations: { id: string }[]; annotations_not_shown?: number };
  expect(copied.annotations).toHaveLength(N);
  expect(copied.annotations_not_shown).toBeUndefined();

  // the header stays in view (sticky) and keyboard: Tab-walk selection also scrolls to the row
  await page.getByRole("group", { name: "Radiograph annotation area" }).focus();
  await table.evaluate((t) => { (t.parentElement as HTMLElement).scrollTop = 0; });
  await page.keyboard.press("Tab");
  await expect(page.locator('tr[aria-current="true"]')).toHaveCount(1);
  expect(watch.problems()).toEqual([]);
  await ctx.close();
});
