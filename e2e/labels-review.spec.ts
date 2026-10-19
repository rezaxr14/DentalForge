/**
 * M9 slice 2 part 3, layer 3c (ADR-0020): the Review, Export and queue pages read the SERVER's sets (one read-only
 * GET /api/labels) when a session with an active organisation exists, and this browser's drafts otherwise. Real users and
 * organisations, including an invited REVIEWER deciding someone else's set, in a real browser against the production build.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { DB_URL, SECRETS, startApp, type RunningApp } from "./support/app";
import { watchPage } from "./support/page-watch";

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const SHOTS = process.env.E2E_SHOTS_DIR ?? "";
const creds = { password: "browser-e2e-pass-123" };

let app: RunningApp;
test.beforeAll(async () => {
  app = await startApp({ ...SECRETS, DATABASE_URL: DB_URL, WORKER_MODE: "off" });
});
test.afterAll(async () => app.stop());

const headers = () => ({ origin: app.base });
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function signUp(context: BrowserContext, email: string, name: string): Promise<void> {
  const body = { data: { email, ...creds, name }, headers: headers() };
  // Better Auth rate-limits sign-ups per IP: wait out the window it names (that is the server doing its job).
  let su = await context.request.post(`${app.base}/api/auth/sign-up/email`, body);
  for (let i = 0; su.status() === 429 && i < 3; i++) {
    await new Promise((r) => setTimeout(r, (Number(su.headers()["x-retry-after"] ?? "11") + 1) * 1000));
    su = await context.request.post(`${app.base}/api/auth/sign-up/email`, body);
  }
  expect(su.ok(), `sign up ${email} -> ${su.status()}`).toBe(true);
}
async function setActiveOrg(context: BrowserContext): Promise<void> {
  const orgs = (await (await context.request.get(`${app.base}/api/auth/organization/list`)).json()) as { id: string }[];
  const r = await context.request.post(`${app.base}/api/auth/organization/set-active`, { headers: headers(), data: { organizationId: orgs[0]!.id } });
  expect(r.ok(), "set active organization").toBe(true);
}

/** An admin with an organisation whose image 1 holds two boxes and is SUBMITTED (made through the API, which is what the editor calls). */
async function adminWithSubmittedSet(browser: Browser) {
  const context = await browser.newContext({ baseURL: app.base });
  const uid = uniq();
  const email = `admin-${uid}@example.com`;
  await signUp(context, email, "Review admin");
  const org = await context.request.post(`${app.base}/api/auth/organization/create`, { headers: headers(), data: { name: `Rev ${uid}`, slug: `rev-${uid}` } });
  expect(org.ok(), "create organization").toBe(true);
  const opened = (await (await context.request.post(`${app.base}/api/labels/1/open`, { headers: headers(), data: {} })).json()) as { viewer: { userId: string } };
  const box = (id: string, x: number) => ({ id, bbox: [x, 300, 220, 240], fdi_quadrant: 3, fdi_position: 6, pathology: "Caries", source: "human", confidence: null, status: "draft", version: 1, author_id: opened.viewer.userId });
  const ops = await context.request.post(`${app.base}/api/labels/1/ops`, {
    headers: headers(),
    data: { baseVersion: 1, ops: [{ type: "create", annotation: box("a1", 100), index: 0 }, { type: "create", annotation: box("a2", 600), index: 1 }] },
  });
  expect(ops.ok(), "ops").toBe(true);
  const sub = await context.request.post(`${app.base}/api/labels/1/transition`, { headers: headers(), data: { transition: "submit", baseVersion: 2 } });
  expect(sub.ok(), "submit").toBe(true);
  return { context, email, uid };
}

/** A user invited into the admin's organisation as `reviewer`. */
async function invitedReviewer(browser: Browser, admin: BrowserContext) {
  const email = `reviewer-${uniq()}@example.com`;
  const orgs = (await (await admin.request.get(`${app.base}/api/auth/organization/list`)).json()) as { id: string }[];
  const inv = await admin.request.post(`${app.base}/api/auth/organization/invite-member`, { headers: headers(), data: { email, role: "reviewer", organizationId: orgs[0]!.id } });
  expect(inv.ok(), `invite -> ${inv.status()} ${await inv.text()}`).toBe(true);
  const invitationId = ((await inv.json()) as { id: string }).id;
  const context = await browser.newContext({ baseURL: app.base });
  await signUp(context, email, "Reviewer");
  const acc = await context.request.post(`${app.base}/api/auth/organization/accept-invitation`, { headers: headers(), data: { invitationId } });
  expect(acc.ok(), `accept -> ${acc.status()} ${await acc.text()}`).toBe(true);
  await setActiveOrg(context);
  return { context, email };
}

const section = (page: Page, id: string) => page.locator("section").filter({ has: page.getByRole("link", { name: `image ${id}` }) });
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};
const ready = (page: Page) => page.waitForFunction(() => !!document.querySelector("[data-review-source]"));

test("signed in as the author: the Review page shows the server's sets, no demo controls, and the server refuses self-review", async ({ browser }) => {
  const admin = await adminWithSubmittedSet(browser);
  const page = await admin.context.newPage();
  const watch = watchPage(page, app.base, [/403 \(Forbidden\)/]); // the refused self-review is part of the scenario
  await page.goto(`${app.base}/labels/review`);
  await ready(page);
  await expect(page.locator("[data-review-source]")).toHaveAttribute("data-review-source", "server");
  await expect(page.getByText("no auth exists yet")).toHaveCount(0);
  await expect(page.getByText("Demo role:")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reset local state" })).toHaveCount(0);
  await expect(page.locator("[data-viewer]")).toContainText("admin");

  const one = section(page, "1");
  await expect(one).toContainText("submitted · v3 · 2 boxes");
  await expect(one).toContainText("Matched");
  await expect(section(page, "2")).toContainText("No human annotations yet");

  const refused = page.waitForResponse((r) => r.url().endsWith("/api/labels/1/transition") && r.status() === 403);
  await one.getByRole("button", { name: "Approve" }).click();
  await refused;
  await expect(page.getByText("Your role cannot make this decision on this set")).toBeVisible();
  await expect(one).toContainText("submitted · v3"); // nothing changed
  expect(watch.problems()).toEqual([]);
  await admin.context.close();
});

test("an invited reviewer approves someone else's set; Review, Export and the queue then agree (light, dark, axe)", async ({ browser }) => {
  const admin = await adminWithSubmittedSet(browser);
  const rev = await invitedReviewer(browser, admin.context);
  const page = await rev.context.newPage();
  const watch = watchPage(page, app.base);

  await page.goto(`${app.base}/labels/review`);
  await ready(page);
  await expect(page.locator("[data-review-source]")).toHaveAttribute("data-review-source", "server");
  await expect(page.locator("[data-viewer]")).toContainText("reviewer");
  const one = section(page, "1");
  await expect(one).toContainText("submitted · v3 · 2 boxes");

  for (const theme of ["light", "dark"] as const) {
    const p = await rev.context.newPage();
    await p.addInitScript((t) => window.localStorage.setItem("theme", t), theme);
    const w = watchPage(p, app.base);
    await p.goto(`${app.base}/labels/review`);
    await ready(p);
    await expect(section(p, "1")).toContainText("submitted");
    const axe = await new AxeBuilder({ page: p }).withTags(WCAG).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`), `axe review ${theme}`).toEqual([]);
    await shot(p, `review-server-${theme}`);
    expect(w.problems()).toEqual([]);
    await p.close();
  }

  await one.getByRole("textbox", { name: /reason/i }).or(one.getByPlaceholder("Reason (optional)")).fill("Boxes match the consensus");
  const decided = page.waitForResponse((r) => r.url().endsWith("/api/labels/1/transition") && r.status() === 200);
  await one.getByRole("button", { name: "Approve" }).click();
  await decided;
  await expect(page.getByText("image 1: approved.")).toBeVisible();
  await expect(one).toContainText("approved · v4");
  await expect(one.locator("div.rounded.border", { hasText: "Decisions" })).toContainText("approved");

  // the server really holds the decision (read by the author, a different account)
  const set = (await (await admin.context.request.get(`${app.base}/api/labels/1`)).json()) as { state: string; version: number; annotations: { status: string }[] };
  expect(set).toMatchObject({ state: "approved", version: 4 });
  expect(set.annotations.map((a) => a.status)).toEqual(["approved", "approved"]);

  // Export reads the same server set: only approved boxes leave the app, and it says where they come from
  await page.goto(`${app.base}/labels/export`);
  await page.waitForFunction(() => !!document.querySelector("[data-export-source]"));
  await expect(page.locator("[data-export-source]")).toHaveAttribute("data-export-source", "server");
  await expect(page.getByRole("row").filter({ hasText: "image 1" }).getByRole("cell").nth(1)).toHaveText("2");
  await expect(page.getByRole("row").filter({ hasText: "image 2" }).getByRole("cell").nth(1)).toHaveText("0");

  // and so does the queue
  await page.goto(`${app.base}/labels/queue`);
  const row = page.getByRole("row").filter({ hasText: "image 1" });
  await expect(row).toContainText("approved");
  await expect(row.getByRole("cell").nth(3)).toHaveText("2");

  // returning to Review after a reload: no hydration error, same state
  await page.goto(`${app.base}/labels/review`);
  await ready(page);
  await expect(section(page, "1")).toContainText("approved · v4");
  expect(watch.problems()).toEqual([]);
  await rev.context.close();
  await admin.context.close();
});

test("a member who is not a reviewer sees the sets but cannot decide (button disabled, role explained)", async ({ browser }) => {
  const admin = await adminWithSubmittedSet(browser);
  const email = `annot-${uniq()}@example.com`;
  const orgs = (await (await admin.context.request.get(`${app.base}/api/auth/organization/list`)).json()) as { id: string }[];
  const inv = await admin.context.request.post(`${app.base}/api/auth/organization/invite-member`, { headers: headers(), data: { email, role: "annotator", organizationId: orgs[0]!.id } });
  expect(inv.ok(), "invite annotator").toBe(true);
  const ctx = await browser.newContext({ baseURL: app.base });
  await signUp(ctx, email, "Annotator");
  const acc = await ctx.request.post(`${app.base}/api/auth/organization/accept-invitation`, { headers: headers(), data: { invitationId: ((await inv.json()) as { id: string }).id } });
  expect(acc.ok(), "accept").toBe(true);
  await setActiveOrg(ctx);
  const page = await ctx.newPage();
  const watch = watchPage(page, app.base);
  await page.goto(`${app.base}/labels/review`);
  await ready(page);
  await expect(page.locator("[data-viewer]")).toContainText("only reviewers and admins can decide");
  await expect(section(page, "1")).toContainText("submitted · v3");
  await expect(section(page, "1").getByRole("button", { name: "Approve" })).toBeDisabled();
  await expect(section(page, "1").getByRole("button", { name: "Reject" })).toBeDisabled();
  expect(watch.problems()).toEqual([]);
  await ctx.close();
  await admin.context.close();
});

test("signed out: the pages show this browser's drafts, say so, keep the demo role switcher, and the console stays clean", async ({ page }) => {
  const watch = watchPage(page, app.base);
  await page.goto(`${app.base}/labels/review`);
  await ready(page);
  await expect(page.locator("[data-review-source]")).toHaveAttribute("data-review-source", "local");
  await expect(page.locator("[data-review-source]")).toContainText("You are not signed in, or no organization is selected");
  await expect(page.getByText("Demo role:")).toBeVisible();
  await expect(page.getByText("no auth exists yet")).toHaveCount(0);
  await shot(page, "review-local");
  await page.goto(`${app.base}/labels/export`);
  await page.waitForFunction(() => !!document.querySelector("[data-export-source]"));
  await expect(page.locator("[data-export-source]")).toHaveAttribute("data-export-source", "local");
  await page.goto(`${app.base}/labels/queue`);
  await expect(page.getByRole("row").filter({ hasText: "image 1" })).toContainText("unstarted");
  expect(watch.problems()).toEqual([]);
});
