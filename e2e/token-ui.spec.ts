/**
 * Worker-token admin UI in a real browser (M8 task B had only server-rendered
 * and jsdom coverage): create → shown once → copy → revoke, with the token
 * proven to work before revocation and to be refused after it.
 */
import { expect, test, type Page } from "@playwright/test";
import { DB_URL, SECRETS, startApp, type RunningApp } from "./support/app";
import { watchPage } from "./support/page-watch";

let app: RunningApp;
test.beforeAll(async () => {
  app = await startApp({ ...SECRETS, DATABASE_URL: DB_URL, WORKER_MODE: "live" });
});
test.afterAll(async () => app.stop());

/** A real signed-in user (Better Auth, same cookie the app uses); optionally with an org they administer. */
async function signUp(page: Page, { org }: { org: boolean }) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const headers = { origin: app.base };
  const su = await page.request.post(`${app.base}/api/auth/sign-up/email`, {
    headers,
    data: { email: `tok-${id}@example.com`, password: "browser-e2e-pass-123", name: "Token Tester" },
  });
  expect(su.ok(), "sign up").toBe(true);
  if (org) {
    const o = await page.request.post(`${app.base}/api/auth/organization/create`, { headers, data: { name: `Tok Org ${id}`, slug: `tok-${id}` } });
    expect(o.ok(), "create organization").toBe(true);
  }
}

/** Calls the worker API the way a real worker would: bearer token, no browser cookies. */
async function register(request: import("@playwright/test").APIRequestContext, token: string) {
  const res = await request.post(`${app.base}/api/worker/v1/register`, {
    headers: { authorization: `Bearer ${token}`, "x-contract-version": "1" },
    data: { name: "browser-e2e", runtime: "local-gpu", capabilities: [{ job: "system.ping" }] },
  });
  return res.status();
}

test("an admin creates a token (shown once), copies it, and revoking it cuts the worker off", async ({ page, context, request }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signUp(page, { org: true });
  const watch = watchPage(page, app.base);
  await page.goto(`${app.base}/settings`);

  const panel = page.getByTestId("worker-tokens");
  await expect(panel.getByText("No active tokens.")).toBeVisible();

  // Create. The button is disabled until a name is typed.
  const create = panel.getByRole("button", { name: "Create token" });
  await expect(create).toBeDisabled();
  await panel.getByLabel("Name").fill("rtx4090-box");
  await expect(create).toBeEnabled();
  await create.click();

  // Shown once, in full, with the warning.
  const notice = panel.getByRole("status");
  await expect(notice).toContainText("copy it now. It will not be shown again.");
  const token = (await notice.locator("code").innerText()).trim();
  expect(token).toMatch(/^tf_wrk_[A-Za-z0-9_-]{20,}$/);

  // Copy puts exactly that token on the clipboard.
  await notice.getByRole("button", { name: "Copy" }).click();
  await expect(notice.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);

  // The token is live: a worker can register with it.
  expect(await register(request, token)).toBe(200);

  // Dismiss: the secret leaves the DOM and the list shows the token without it.
  await notice.getByRole("button", { name: "I’ve stored it" }).click();
  await expect(notice).toHaveCount(0);
  const item = panel.getByRole("list", { name: /Active worker tokens/ }).getByRole("listitem");
  await expect(item).toContainText("rtx4090-box");
  await expect(item).toContainText("jobs:write");
  await expect(item).toContainText("Last used never"); // client state from the create call; refreshed on reload

  // Reload: the secret can never be shown again, and the server now knows the register call above.
  await page.reload();
  expect(await page.content()).not.toContain(token);
  await expect(item).toContainText("rtx4090-box");
  await expect(item).toContainText(/Last used \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);

  // Revoke needs a confirmation; cancelling keeps the token.
  await panel.getByRole("button", { name: "Revoke token rtx4090-box" }).click();
  await panel.getByRole("button", { name: "Cancel" }).click();
  await expect(panel.getByRole("button", { name: "Revoke token rtx4090-box" })).toBeVisible();
  expect(await register(request, token)).toBe(200);

  // Confirm: it moves to Revoked and the worker is refused.
  await panel.getByRole("button", { name: "Revoke token rtx4090-box" }).click();
  await panel.getByRole("button", { name: "Confirm revoke" }).click();
  await expect(panel.getByText("No active tokens.")).toBeVisible();
  await expect(panel.getByText("Revoked (1)")).toBeVisible();
  expect(await register(request, token)).toBe(401);

  expect(watch.problems()).toEqual([]);
});

test("a signed-in user with no organization sees no token controls", async ({ page }) => {
  await signUp(page, { org: false });
  const watch = watchPage(page, app.base);
  await page.goto(`${app.base}/settings`);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("No organizations yet.")).toBeVisible();
  await expect(page.getByTestId("worker-tokens")).toHaveCount(0);
  expect(watch.problems()).toEqual([]);
});
