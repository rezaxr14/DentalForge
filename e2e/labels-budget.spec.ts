/**
 * Performance budget of the editor with 500 boxes (ADR-0021). Asserts on WORK, not frame rate: script, layout and style
 * time that Chromium itself counts, and the size of the DOM. Wall-clock frame times in headless software rendering are too
 * noisy to gate on (the idle floor alone varied 25-146 ms between runs), but these counters are stable and the ceilings
 * are loose (5-10x what a fixed editor measures) while the editor this replaced was 10-70x over them:
 *   drag, per pointer move   script 75 ms  layout 44 ms     (now ~0.7 / ~0.6)
 *   keypress that edits a box  layout 38 ms                  (now <1)
 *   DOM nodes                15,272                          (now ~1,200)
 * and, zoomed (ADR-0022): a zoom step, a pan step and a drag at ×5 stay inside the same kind of ceilings.
 * `pnpm perf:editor` prints the full picture (frames, long animation frames, CPU profile).
 */
import { expect, test, type Browser } from "@playwright/test";
import { DB_URL, SECRETS, startApp, type RunningApp } from "./support/app";

const N = 500;
let app: RunningApp;
test.beforeAll(async () => {
  app = await startApp({ ...SECRETS, DATABASE_URL: DB_URL, WORKER_MODE: "off" });
});
test.afterAll(async () => app.stop());

const headers = () => ({ origin: app.base });

async function seeded(browser: Browser) {
  const ctx = await browser.newContext({ baseURL: app.base });
  const uid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const email = `budget-${uid}@example.com`;
  const body = { data: { email, password: "browser-e2e-pass-123", name: "Budget" }, headers: headers() };
  let su = await ctx.request.post(`${app.base}/api/auth/sign-up/email`, body);
  for (let i = 0; su.status() === 429 && i < 3; i++) {
    await new Promise((r) => setTimeout(r, (Number(su.headers()["x-retry-after"] ?? "11") + 1) * 1000));
    su = await ctx.request.post(`${app.base}/api/auth/sign-up/email`, body);
  }
  expect(su.ok()).toBe(true);
  expect((await ctx.request.post(`${app.base}/api/auth/organization/create`, { headers: headers(), data: { name: `Bud ${uid}`, slug: `bud-${uid}` } })).ok()).toBe(true);
  const opened = (await (await ctx.request.post(`${app.base}/api/labels/1/open`, { headers: headers(), data: {} })).json()) as { viewer: { userId: string } };
  const box = (i: number) => ({
    id: `b${i}`, bbox: [60 + (i % 25) * 105, 60 + Math.floor(i / 25) * 60, 95, 50], fdi_quadrant: 1 + (i % 4), fdi_position: 1 + (i % 8),
    pathology: "Caries", source: "human", confidence: null, status: "draft", version: 1, author_id: opened.viewer.userId,
  });
  let version = 1;
  for (let from = 0; from < N; from += 200) {
    const ops = Array.from({ length: Math.min(200, N - from) }, (_, k) => ({ type: "create", annotation: box(from + k), index: from + k }));
    expect((await ctx.request.post(`${app.base}/api/labels/1/ops`, { headers: headers(), data: { baseVersion: version, ops } })).ok()).toBe(true);
    version++;
  }
  return ctx;
}

test("500 boxes: dragging, editing and the DOM stay inside the work budget", async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await seeded(browser);
  const page = await ctx.newPage();
  await page.goto(`${app.base}/labels/1`);
  await expect(page.locator("[data-sync-status=saved]")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(`${N} boxes`).first()).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>('img[alt^="Radiograph"]')?.complete === true);

  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = async () => Object.fromEntries(((await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] }).metrics.map((m) => [m.name, m.value]));
  const frame = () => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  const work = async (steps: number, run: () => Promise<void>) => {
    const a = await metrics();
    await run();
    const z = await metrics();
    const per = (k: string) => (((z[k] ?? 0) - (a[k] ?? 0)) * 1000) / steps;
    return { script: per("ScriptDuration"), layout: per("LayoutDuration"), style: per("RecalcStyleDuration") };
  };

  // dragging a box: 60 pointer moves
  const target = (await page.locator('[data-box-id="b30"]').first().boundingBox())!;
  const cx = target.x + target.width / 2;
  const cy = target.y + target.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const drag = await work(60, async () => {
    for (let i = 1; i <= 60; i++) {
      await page.mouse.move(cx + i * 3, cy + i * 1.5);
      await frame();
    }
  });
  await page.mouse.up();

  // editing the selected box from the keyboard: 12 presses
  const keys = await work(12, async () => {
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press(`Alt+Digit${1 + (i % 4)}`);
      await frame();
    }
  });
  const dom = await page.evaluate(() => document.getElementsByTagName("*").length);

  // zoomed (ADR-0022): a zoom step re-lays out 500 percent-positioned boxes once; a drag and a pan stay as cheap as at fit
  await page.getByRole("group", { name: "Radiograph annotation area" }).focus();
  const zoomStep = await work(8, async () => {
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press(i % 2 === 0 ? "+" : "-");
      await frame();
    }
  });
  for (let i = 0; i < 4; i++) await page.keyboard.press("+"); // ×5
  await frame();
  const pan = await work(20, async () => {
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press(i % 2 === 0 ? "Shift+ArrowRight" : "Shift+ArrowLeft");
      await frame();
    }
  });
  const inView = await page.evaluate(() => {
    const r = document.querySelector('[aria-label="Radiograph annotation area"]')!.getBoundingClientRect();
    for (const el of document.querySelectorAll<HTMLElement>("[data-box-id]")) {
      const b = el.getBoundingClientRect();
      if (b.left > r.left + 20 && b.right < r.right - 80 && b.top > r.top + 20 && b.bottom < r.bottom - 40) return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }
    return null;
  });
  expect(inView, "a whole box is in view at ×5").not.toBeNull();
  await page.mouse.move(inView!.x, inView!.y);
  await page.mouse.down();
  const zoomedDrag = await work(40, async () => {
    for (let i = 1; i <= 40; i++) {
      await page.mouse.move(inView!.x + i * 1.5, inView!.y + i * 0.5);
      await frame();
    }
  });
  await page.mouse.up();

  console.log(`BUDGET ${JSON.stringify({ drag, keys, dom, zoomStep, pan, zoomedDrag })}`);
  expect(drag.script, "drag: script ms per pointer move").toBeLessThan(6);
  expect(drag.layout, "drag: layout ms per pointer move").toBeLessThan(5);
  expect(keys.script, "edit: script ms per keypress").toBeLessThan(40);
  expect(keys.layout, "edit: layout ms per keypress").toBeLessThan(10);
  expect(dom, "DOM nodes with 500 boxes").toBeLessThan(3000);
  expect(zoomStep.layout, "zoom: layout ms per zoom step").toBeLessThan(40);
  expect(zoomStep.script, "zoom: script ms per zoom step").toBeLessThan(20);
  expect(pan.script, "pan: script ms per pan step").toBeLessThan(6);
  expect(pan.layout, "pan: layout ms per pan step").toBeLessThan(8);
  expect(zoomedDrag.script, "zoomed drag: script ms per pointer move").toBeLessThan(6);
  expect(zoomedDrag.layout, "zoomed drag: layout ms per pointer move").toBeLessThan(5);
  await ctx.close();
});
