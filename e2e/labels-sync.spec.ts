/**
 * M9 slice 2 part 3 (ADR-0020): the editor on the server, in a real browser with REAL sessions (Better Auth users and
 * organisations against Postgres), through the production build. What the unit tests cannot show: that the page really
 * saves, reloads what it saved, merges a conflict without losing edits, goes read-only, and says where the boxes live.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { DB_URL, DEAD_DB, SECRETS, startApp, type RunningApp } from "./support/app";
import { watchPage } from "./support/page-watch";

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const SHOTS = process.env.E2E_SHOTS_DIR ?? "";

let app: RunningApp;
test.beforeAll(async () => {
  app = await startApp({ ...SECRETS, DATABASE_URL: DB_URL, WORKER_MODE: "off" });
});
test.afterAll(async () => app.stop());

const region = (page: Page) => page.getByRole("group", { name: "Radiograph annotation area" });
const rows = (page: Page) => page.getByRole("table").getByRole("row").filter({ has: page.getByRole("button", { name: /^Select box/ }) });
const badge = (page: Page) => page.locator("[data-sync-status]");
const header = (page: Page) => page.locator("span.rounded.border", { hasText: /^(draft|submitted|approved|rejected) · v\d+$/ });

async function open(page: Page, base = app.base) {
  await page.goto(`${base}/labels/1`);
  await page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>('img[alt^="Radiograph"]');
    return !!img && img.complete && img.naturalWidth > 0;
  });
  // Drawing is ignored while the page is still deciding between server and browser storage, so wait for that decision.
  await page.waitForFunction(() => {
    const b = document.querySelector("[data-sync-status]");
    return !!b && b.getAttribute("data-sync-status") !== "loading";
  });
}
async function draw(page: Page, x0: number, y0: number, x1: number, y1: number) {
  const b = (await region(page).boundingBox())!;
  await page.mouse.move(b.x + b.width * x0, b.y + b.height * y0);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * ((x0 + x1) / 2), b.y + b.height * ((y0 + y1) / 2), { steps: 4 });
  await page.mouse.move(b.x + b.width * x1, b.y + b.height * y1, { steps: 4 });
  await page.mouse.up();
}
/** Draw and wait for the server to have answered the save that follows. */
async function drawAndSave(page: Page, ...c: [number, number, number, number]) {
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/labels/1/ops") && r.request().method() === "POST");
  await draw(page, ...c);
  return saved;
}

const creds = { password: "browser-e2e-pass-123" };
async function signUp(context: BrowserContext, tag: string, withOrg: boolean): Promise<{ email: string }> {
  const uid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const email = `${tag}-${uid}@example.com`;
  const headers = { origin: app.base };
  const body = { data: { email, ...creds, name: `Sync ${tag}` }, headers };
  // Better Auth rate-limits sign-ups per IP: wait out the window it names (that is the server doing its job).
  let su = await context.request.post(`${app.base}/api/auth/sign-up/email`, body);
  for (let i = 0; su.status() === 429 && i < 3; i++) {
    await new Promise((r) => setTimeout(r, (Number(su.headers()["x-retry-after"] ?? "11") + 1) * 1000));
    su = await context.request.post(`${app.base}/api/auth/sign-up/email`, body);
  }
  expect(su.ok(), `sign up -> ${su.status()}`).toBe(true);
  if (withOrg) {
    const o = await context.request.post(`${app.base}/api/auth/organization/create`, { headers, data: { name: `Sync ${uid}`, slug: `sync-${uid}` } });
    expect(o.ok(), "create organization").toBe(true);
  }
  return { email };
}
async function signedIn(browser: Browser, tag: string, theme: "light" | "dark" = "light") {
  const context = await browser.newContext({ baseURL: app.base });
  const user = await signUp(context, tag, true);
  const page = await context.newPage();
  await page.addInitScript((t) => window.localStorage.setItem("theme", t), theme);
  return { context, page, user };
}
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};

test("signed in: a drawn box is saved to the server, survives a reload, and the page says so (light, dark, mobile, axe)", async ({ browser }) => {
  const { context, page } = await signedIn(browser, "draw");
  const watch = watchPage(page, app.base);
  await open(page);
  await expect(badge(page)).toHaveAttribute("data-sync-mode", "server");
  await expect(badge(page)).toHaveAttribute("data-sync-status", "saved");
  await expect(badge(page)).toHaveText("Saved to server");

  const res = await drawAndSave(page, 0.2, 0.3, 0.3, 0.5);
  expect(res.status()).toBe(200);
  await drawAndSave(page, 0.5, 0.3, 0.6, 0.5);
  await page.getByRole("combobox", { name: "Pathology for box 1" }).selectOption("Impacted");
  await expect(badge(page)).toHaveAttribute("data-sync-status", "saved", { timeout: 10_000 });
  await expect(rows(page)).toHaveCount(2);
  // Boxes carry the signed-in user as author in the editor too, not just on the wire (the set JSON shows what the editor holds).
  const viewerId = ((await (await page.request.get(`${app.base}/api/labels/1`)).json()) as { viewer: { userId: string } }).viewer.userId;
  await expect(page.getByRole("region", { name: "Annotation set as JSON" })).toContainText(`"author_id": "${viewerId}"`);

  await page.reload();
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>('img[alt^="Radiograph"]')?.complete === true);
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole("combobox", { name: "Pathology for box 1" })).toHaveValue("Impacted");
  await expect(badge(page)).toHaveAttribute("data-sync-status", "saved");
  await expect(header(page)).toContainText("draft");
  expect(watch.problems()).toEqual([]);

  // The same realistic page (two boxes, one relabelled, returning user) in both themes and on a phone.
  for (const theme of ["light", "dark"] as const) {
    const p = await context.newPage();
    await p.addInitScript((t) => window.localStorage.setItem("theme", t), theme);
    const w = watchPage(p, app.base);
    await open(p);
    await expect(rows(p)).toHaveCount(2);
    await expect(badge(p)).toHaveAttribute("data-sync-status", "saved");
    const axe = await new AxeBuilder({ page: p }).withTags(WCAG).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`), `axe ${theme}`).toEqual([]);
    await shot(p, `server-${theme}`);
    if (theme === "dark") {
      await p.setViewportSize({ width: 390, height: 844 });
      await expect(badge(p)).toBeVisible();
      await shot(p, "server-dark-mobile");
      // No horizontal page scroll on a phone with realistic state. The failure names what sticks out: anything unclipped, and
      // anything absolutely positioned (a `sr-only` cell in a table once escaped its scroller and widened the page by 81 px).
      const stickingOut = await p.evaluate(() => {
        const w = window.innerWidth;
        const clipped = (el: HTMLElement): boolean => {
          for (let q = el.parentElement; q; q = q.parentElement) {
            const o = getComputedStyle(q).overflowX;
            if (o === "auto" || o === "hidden" || o === "scroll") return true;
          }
          return false;
        };
        const out: string[] = [];
        document.querySelectorAll<HTMLElement>("body *").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.right > w + 1 && (!clipped(el) || getComputedStyle(el).position === "absolute")) out.push(`${el.tagName.toLowerCase()}[${String(el.className).slice(0, 40)}] right=${Math.round(r.right)}`);
        });
        return { scrollWidth: document.documentElement.scrollWidth, viewport: w, elements: out.slice(0, 6) };
      });
      expect(stickingOut.scrollWidth - stickingOut.viewport, `no horizontal scroll on a phone: ${JSON.stringify(stickingOut)}`).toBeLessThanOrEqual(0);
    }
    expect(w.problems()).toEqual([]);
    await p.close();
  }
  await context.close();
});

test("two tabs of the same account edit at once: the stale one merges instead of losing work or overwriting", async ({ browser }) => {
  const a = await signedIn(browser, "conflict");
  const ctxB = await browser.newContext({ baseURL: app.base });
  const login = await ctxB.request.post(`${app.base}/api/auth/sign-in/email`, { headers: { origin: app.base }, data: { email: a.user.email, ...creds } });
  expect(login.ok(), "second sign-in").toBe(true);
  // A new session has no active organization (the header's switcher sets it); until then the labels API treats it as signed out.
  const orgs = (await (await ctxB.request.get(`${app.base}/api/auth/organization/list`)).json()) as { id: string }[];
  const active = await ctxB.request.post(`${app.base}/api/auth/organization/set-active`, { headers: { origin: app.base }, data: { organizationId: orgs[0]!.id } });
  expect(active.ok(), "set active organization").toBe(true);
  const pageB = await ctxB.newPage();
  const watchB = watchPage(pageB, app.base, [/409 \(Conflict\)/]); // the conflict IS the scenario: the browser logs the 409 itself
  const watchA = watchPage(a.page, app.base);
  await open(a.page);
  await open(pageB);
  await expect(badge(pageB)).toHaveAttribute("data-sync-status", "saved");

  await drawAndSave(a.page, 0.2, 0.3, 0.3, 0.5); // tab A saves version 2
  const conflict = pageB.waitForResponse((r) => r.url().endsWith("/ops") && r.status() === 409);
  await draw(pageB, 0.6, 0.3, 0.7, 0.5); // tab B still believes version 1
  await conflict;
  await expect(rows(pageB)).toHaveCount(2); // its own box AND the other tab's
  await expect(badge(pageB)).toHaveAttribute("data-sync-status", "merged", { timeout: 10_000 });
  await expect(pageB.locator("[data-sync-detail]")).toContainText("both kept");
  await shot(pageB, "server-merged");

  await a.page.reload();
  await expect(rows(a.page)).toHaveCount(2);
  expect(watchA.problems()).toEqual([]);
  expect(watchB.problems()).toEqual([]);
  await a.context.close();
  await ctxB.close();
});

test("submitting makes the set read-only everywhere (pointer, keyboard, table, buttons) and the server refuses self-review", async ({ browser }) => {
  const { context, page } = await signedIn(browser, "submit");
  const watch = watchPage(page, app.base, [/403 \(Forbidden\)/]); // the refused self-review is part of the scenario
  await open(page);
  await drawAndSave(page, 0.2, 0.3, 0.3, 0.5);
  await expect(badge(page)).toHaveAttribute("data-sync-status", "saved", { timeout: 10_000 });

  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(header(page)).toContainText("submitted", { timeout: 10_000 });
  await expect(badge(page)).toHaveAttribute("data-sync-status", "readonly");
  await expect(badge(page)).toContainText("Read-only · submitted");

  // nothing can change a box any more: mouse, keyboard, table, sidebar
  await draw(page, 0.5, 0.3, 0.6, 0.5);
  await expect(rows(page)).toHaveCount(1);
  await rows(page).first().getByRole("button", { name: /^Select box/ }).click();
  await page.keyboard.press("Delete");
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByRole("combobox", { name: "Pathology for box 1" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Delete box 1" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Mirror to" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Submit for review" })).toBeDisabled();
  await shot(page, "server-readonly");

  // the signed-in user is an admin, but drew the boxes: the server refuses the approval
  const refused = page.waitForResponse((r) => r.url().endsWith("/transition") && r.status() === 403);
  await page.getByRole("button", { name: "Approve" }).click();
  await refused;
  await expect(page.getByText("Your role cannot make this decision on this set")).toBeVisible();
  await expect(header(page)).toContainText("submitted");
  expect(watch.problems()).toEqual([]);
  await context.close();
});

test("signed out on a deployment with a database: boxes stay in this browser, the page says so, and the console stays clean", async ({ page }) => {
  const watch = watchPage(page, app.base);
  await open(page);
  await expect(badge(page)).toHaveAttribute("data-sync-mode", "local");
  await expect(badge(page)).toHaveText("Saved in this browser only");
  await expect(page.locator("[data-sync-detail]")).toContainText("Sign in");
  await draw(page, 0.2, 0.3, 0.3, 0.5);
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Save draft" })).toBeEnabled();
  await shot(page, "local-signed-out");
  expect(watch.problems()).toEqual([]);
});

test("browser-only drafts are read-only too once submitted (the gate does not depend on the server)", async ({ page }) => {
  const watch = watchPage(page, app.base);
  await open(page);
  await expect(badge(page)).toHaveAttribute("data-sync-mode", "local");
  await draw(page, 0.2, 0.3, 0.3, 0.5);
  await expect(rows(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(header(page)).toContainText("submitted");
  await draw(page, 0.5, 0.3, 0.6, 0.5);
  await rows(page).first().getByRole("button", { name: /^Select box/ }).click();
  await page.keyboard.press("Delete");
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByRole("combobox", { name: "Pathology for box 1" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
  expect(watch.problems()).toEqual([]);
});

test("the session ends mid-edit: the edits move to this browser and survive a reload", async ({ browser }) => {
  const { context, page } = await signedIn(browser, "expire");
  const watch = watchPage(page, app.base, [/401 \(Unauthorized\)/]);
  await open(page);
  await expect(badge(page)).toHaveAttribute("data-sync-mode", "server");
  await context.clearCookies(); // signed out in another tab, cookie expired, ...
  await draw(page, 0.2, 0.3, 0.3, 0.5);
  await expect(badge(page)).toHaveAttribute("data-sync-mode", "local", { timeout: 10_000 });
  await expect(page.locator("[data-sync-detail]")).toContainText("You were signed out");
  await expect(rows(page)).toHaveCount(1);
  await page.reload();
  await expect(badge(page)).toHaveAttribute("data-sync-mode", "local");
  await expect(rows(page)).toHaveCount(1); // kept in the browser store
  expect(watch.problems()).toEqual([]);
  await context.close();
});

test("with the database down the editor works in this browser and says so, without a single console error", async ({ page }) => {
  const dead = await startApp({ ...SECRETS, DATABASE_URL: DEAD_DB, WORKER_MODE: "off" });
  try {
    const watch = watchPage(page, dead.base);
    await open(page, dead.base);
    await expect(badge(page)).toHaveAttribute("data-sync-mode", "local");
    await expect(page.locator("[data-sync-detail]")).toContainText("could not be reached");
    await draw(page, 0.2, 0.3, 0.3, 0.5);
    await expect(rows(page)).toHaveCount(1);
    expect(watch.problems()).toEqual([]);
  } finally {
    await dead.stop();
  }
});
