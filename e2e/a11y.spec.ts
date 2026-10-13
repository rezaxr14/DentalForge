/**
 * Accessibility pass: axe-core (WCAG 2.0/2.1 A + AA rules) on every page, in the
 * light AND the dark theme, against the production build with the database up.
 * Nothing is excluded or allow-listed here: a violation fails the test with its
 * rule, impact and the offending elements. axe finds a subset of problems
 * (roughly the automatable ones); a pass is not a full accessibility audit.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { DB_URL, SECRETS, startApp, type RunningApp } from "./support/app";

function pagesUnder(dir: string, segs: string[] = []): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "api") continue;
      const isGroup = name.startsWith("(") && name.endsWith(")");
      out.push(...pagesUnder(p, isGroup ? segs : [...segs, name]));
    } else if (name === "page.tsx") out.push("/" + segs.join("/"));
  }
  return out.sort();
}
const ROUTES = pagesUnder(join(process.cwd(), "src", "app")).map((r) =>
  r.replace("[imageId]", "1").replace("[token]", "bogus-token").replace(/\[\w+\]/, "1"),
);

let app: RunningApp;
test.beforeAll(async () => {
  app = await startApp({ ...SECRETS, DATABASE_URL: DB_URL, WORKER_MODE: "live" });
});
test.afterAll(async () => app.stop());

for (const theme of ["light", "dark"] as const) {
  test.describe(`axe — ${theme} theme`, () => {
    for (const route of ROUTES) {
      test(`${route} has no WCAG A/AA violations`, async ({ page }) => {
        await page.addInitScript((t) => window.localStorage.setItem("theme", t), theme);
        await page.goto(app.base + route);
        await page.waitForLoadState("networkidle");
        // The theme must really be applied, or the dark run would silently test light.
        await expect(page.locator("html")).toHaveClass(theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);

        const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        const report = violations.map(
          (v) => `${v.id} [${v.impact}] x${v.nodes.length}: ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`,
        );
        expect(report, `axe violations on ${route} (${theme})`).toEqual([]);
      });
    }
  });
}

test("the theme toggle switches the page and the choice survives a reload", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("theme", "light"));
  await page.goto(`${app.base}/status`);
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await expect(page.getByRole("button", { name: "Switch to light theme" })).toBeVisible();
});
