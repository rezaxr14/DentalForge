/**
 * Pages must hydrate under the Content-Security-Policy the production server really sends (ADR-0028 amendment).
 *
 * Regression: `script-src 'self'` made the browser refuse every inline bootstrap script ("Refused to execute inline
 * script ..."), React threw #412 and no page hydrated: static HTML, dead controls. The strict console watcher sees the
 * console errors; this spec also listens for `securitypolicyviolation` events and proves that client code ran.
 */
import { expect, test } from "@playwright/test";
import { startApp, DEAD_DB, SECRETS, type RunningApp } from "./support/app";
import { watchPage } from "./support/page-watch";

const PAGES = ["/", "/labels/1", "/agent", "/traces", "/training", "/about-data"];

test.describe("security headers and hydration under the real CSP", () => {
  let app: RunningApp;
  test.beforeAll(async () => {
    // Fixture-backed pages: no database needed.
    app = await startApp({ ...SECRETS, DATABASE_URL: DEAD_DB, WORKER_MODE: "off" });
  });
  test.afterAll(async () => app.stop());

  for (const path of PAGES) {
    test(`${path}: headers present, no CSP violation, no console problem`, async ({ page }) => {
      await page.addInitScript(() => {
        (window as unknown as { __csp: string[] }).__csp = [];
        document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
      });
      const watch = watchPage(page, app.base);
      const res = await page.goto(`${app.base}${path}`);
      const h = res!.headers();
      expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(h["content-security-policy"]).toContain("object-src 'none'");
      expect(h["content-security-policy"]).toMatch(/script-src [^;]*'self'/);
      expect(h["x-content-type-options"]).toBe("nosniff");
      expect(h["x-frame-options"]).toBe("DENY");
      await page.waitForLoadState("networkidle");
      expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp), "CSP violations").toEqual([]);
      expect(watch.problems()).toEqual([]);
    });
  }

  test("client code runs: the editor leaves its connecting phase (impossible without hydration)", async ({ page }) => {
    const watch = watchPage(page, app.base);
    await page.goto(`${app.base}/labels/1`);
    await expect(page.getByRole("button", { name: /^Connecting/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
    expect(watch.problems()).toEqual([]);
  });

  test("an API response carries the headers too, once", async ({ request }) => {
    const res = await request.get(`${app.base}/api/health`);
    const headers = res.headersArray().filter((h) => h.name.toLowerCase() === "content-security-policy");
    expect(headers).toHaveLength(1);
    expect(headers[0]!.value).toContain("default-src 'self'");
  });
});
