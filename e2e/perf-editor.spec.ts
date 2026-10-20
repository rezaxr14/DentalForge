/**
 * Editor performance measurements (M9 slice 3). NOT part of `pnpm e2e:browser`: it is opt-in (`pnpm perf:editor`) because
 * timings depend on the machine. It drives the REAL editor (production build, real session, boxes seeded through the API)
 * with 100 and 500 boxes and records, per scenario: the time from a dispatched input to the next painted frame, frames over
 * budget, long animation frames, and (for the drag) a CPU profile by function. Results go to perf-results/editor-<label>.json.
 * Headless software rendering: compare numbers between runs on the SAME machine, do not read them as a frame rate.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { DB_URL, SECRETS, startApp, type RunningApp } from "./support/app";

const LABEL = process.env.E2E_PERF_LABEL ?? "run";
const SIZES = (process.env.E2E_PERF_SIZES ?? "100,500").split(",").map(Number);
const creds = { password: "browser-e2e-pass-123" };

let app: RunningApp;
test.beforeAll(async () => {
  app = await startApp({ ...SECRETS, DATABASE_URL: DB_URL, WORKER_MODE: "off" });
});
test.afterAll(async () => app.stop());

const headers = () => ({ origin: app.base });
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]! : 0);
const summary = (xs: number[]) => ({ n: xs.length, p50: +pct(xs, 50).toFixed(1), p95: +pct(xs, 95).toFixed(1), max: +Math.max(0, ...xs).toFixed(1), over50: xs.filter((x) => x > 50).length, over16: xs.filter((x) => x > 16.7).length });

async function seed(browser: Browser, n: number) {
  const ctx = await browser.newContext({ baseURL: app.base });
  const uid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const email = `perf-${uid}@example.com`;
  let su = await ctx.request.post(`${app.base}/api/auth/sign-up/email`, { data: { email, ...creds, name: "Perf" }, headers: headers() });
  for (let i = 0; su.status() === 429 && i < 3; i++) {
    await new Promise((r) => setTimeout(r, (Number(su.headers()["x-retry-after"] ?? "11") + 1) * 1000));
    su = await ctx.request.post(`${app.base}/api/auth/sign-up/email`, { data: { email, ...creds, name: "Perf" }, headers: headers() });
  }
  expect(su.ok()).toBe(true);
  await ctx.request.post(`${app.base}/api/auth/organization/create`, { headers: headers(), data: { name: `Perf ${uid}`, slug: `perf-${uid}` } });
  const opened = (await (await ctx.request.post(`${app.base}/api/labels/1/open`, { headers: headers(), data: {} })).json()) as { viewer: { userId: string } };
  const box = (i: number) => ({
    id: `p${i}`, bbox: [60 + (i % 25) * 105, 60 + Math.floor(i / 25) * 60, 95, 50], fdi_quadrant: 1 + (i % 4), fdi_position: 1 + (i % 8),
    pathology: "Caries", source: "human", confidence: null, status: "draft", version: 1, author_id: opened.viewer.userId,
  });
  let version = 1;
  for (let from = 0; from < n; from += 200) {
    const ops = Array.from({ length: Math.min(200, n - from) }, (_, k) => ({ type: "create", annotation: box(from + k), index: from + k }));
    const r = await ctx.request.post(`${app.base}/api/labels/1/ops`, { headers: headers(), data: { baseVersion: version, ops } });
    expect(r.ok(), `seed ${from}`).toBe(true);
    version++;
  }
  return ctx;
}

const INSTRUMENT = () => {
  const w = window as unknown as { __perf: { loaf: number[]; blocking: number[]; events: number[] } };
  w.__perf = { loaf: [], blocking: [], events: [] };
  try {
    new PerformanceObserver((l) => l.getEntries().forEach((e) => { w.__perf.loaf.push(e.duration); w.__perf.blocking.push((e as unknown as { blockingDuration: number }).blockingDuration); })).observe({ type: "long-animation-frame", buffered: true });
  } catch { /* not supported */ }
  try {
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__perf.events.push(e.duration))).observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit);
  } catch { /* not supported */ }
};

/** Dispatch one input, then wait for the next painted frame; returns ms from just before the dispatch to that frame. */
async function frameAfter(page: Page, act: () => Promise<void>): Promise<number> {
  const t0 = await page.evaluate(() => performance.now());
  await act();
  const t1 = await page.evaluate(() => new Promise<number>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now())))));
  return t1 - t0;
}

for (const n of SIZES) {
  test(`editor with ${n} boxes`, async ({ browser }) => {
    test.setTimeout(240_000);
    const ctx = await seed(browser, n);
    const page = await ctx.newPage();
    await page.addInitScript(INSTRUMENT);
    const t0 = Date.now();
    await page.goto(`${app.base}/labels/1`);
    await expect(page.locator("[data-sync-status=saved]")).toBeVisible({ timeout: 60_000 });
    // Above 40 boxes the table is windowed: its size is announced by aria-rowcount (boxes + header), not by rows in the DOM.
    if (n > 40) await expect(page.getByRole("table")).toHaveAttribute("aria-rowcount", String(n + 1), { timeout: 60_000 });
    else await expect(page.getByRole("table").getByRole("row").filter({ has: page.getByRole("button", { name: /^Select box/ }) })).toHaveCount(n, { timeout: 60_000 });
    const loadMs = Date.now() - t0;
    await page.waitForFunction(() => document.querySelector<HTMLImageElement>('img[alt^="Radiograph"]')?.complete === true);

    const box = async (id: string) => (await page.locator(`[data-box-id="${id}"]`).first().boundingBox())!;
    const results: Record<string, unknown> = { boxes: n, loadMs };

    // 0. the harness floor: the same wait with NOTHING dispatched (two animation frames plus two CDP round trips)
    const idle: number[] = [];
    for (let i = 0; i < 30; i++) idle.push(await frameAfter(page, async () => {}));
    results.floor = summary(idle);

    // 1. drag a box across the image: 80 moves, each followed by a painted frame. The CPU profile is opt-in because the
    //    profiler itself slows the page down a lot (timings from a profiled run are not comparable).
    const profile = process.env.E2E_PERF_PROFILE === "1";
    const cdp = await ctx.newCDPSession(page);
    if (profile) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
      await cdp.send("Profiler.start");
    }
    // Chromium's own counters (no profiler overhead): where does the time of the drag go?
    await cdp.send("Performance.enable");
    const metrics = async () => Object.fromEntries(((await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] }).metrics.map((m) => [m.name, m.value]));
    const work = async <T,>(name: string, steps: number, fn: () => Promise<T>): Promise<T> => {
      const a = await metrics();
      const out = await fn();
      const z = await metrics();
      const d = (k: string) => +(((z[k] ?? 0) - (a[k] ?? 0)) * 1000).toFixed(0);
      results[`${name}Work`] = { steps, scriptMs: d("ScriptDuration"), layoutMs: d("LayoutDuration"), styleMs: d("RecalcStyleDuration"), layouts: Math.round((z.LayoutCount ?? 0) - (a.LayoutCount ?? 0)) };
      return out;
    };
    const m0 = await metrics();
    const b = await box("p30");
    const drag: number[] = [];
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 80; i++) drag.push(await frameAfter(page, () => page.mouse.move(b.x + b.width / 2 + i * 3, b.y + b.height / 2 + i * 1.5)));
    await page.mouse.up();
    const m1 = await metrics();
    const ms = (k: string) => +(((m1[k] ?? 0) - (m0[k] ?? 0)) * 1000).toFixed(0);
    results.dragWork = { scriptMs: ms("ScriptDuration"), layoutMs: ms("LayoutDuration"), styleMs: ms("RecalcStyleDuration"), taskMs: ms("TaskDuration"), layoutCount: Math.round((m1.LayoutCount ?? 0) - (m0.LayoutCount ?? 0)), styleRecalcs: Math.round((m1.RecalcStyleCount ?? 0) - (m0.RecalcStyleCount ?? 0)), moves: 80 };
    let top: { fn: string; selfMs: number }[] = [];
    if (profile) {
      const prof = (await cdp.send("Profiler.stop")).profile as { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]; samples: number[]; timeDeltas: number[] };
      const self = new Map<string, number>();
      const byId = new Map(prof.nodes.map((nd) => [nd.id, nd]));
      prof.samples.forEach((id, i) => {
        const cf = byId.get(id)!.callFrame;
        const key = `${cf.functionName || "(anonymous)"} ${cf.url.split("/").slice(-2).join("/")}:${cf.lineNumber}`;
        self.set(key, (self.get(key) ?? 0) + (prof.timeDeltas[i] ?? 0) / 1000);
      });
      top = [...self.entries()].sort((a, c) => c[1] - a[1]).slice(0, 14).map(([k, ms]) => ({ fn: k, selfMs: +ms.toFixed(0) }));
    }
    results.drag = summary(drag);
    results.dragTop = top;

    // 2. rubber-band draw in empty space: 60 moves
    const region = (await page.getByRole("group", { name: "Radiograph annotation area" }).boundingBox())!;
    const draw: number[] = [];
    await page.mouse.move(region.x + region.width * 0.05, region.y + region.height * 0.9);
    await page.mouse.down();
    for (let i = 1; i <= 60; i++) draw.push(await frameAfter(page, () => page.mouse.move(region.x + region.width * (0.05 + i * 0.004), region.y + region.height * (0.9 + i * 0.001))));
    await page.mouse.up();
    results.draw = summary(draw);

    // 3. select another box by click, twenty times
    const click: number[] = [];
    const targets: { x: number; y: number }[] = [];
    for (let i = 0; i < 20; i++) {
      const bb = await box(`p${(40 + i * 3) % n}`);
      targets.push({ x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 });
    }
    await work("select", 20, async () => {
      for (const t of targets) click.push(await frameAfter(page, () => page.mouse.click(t.x, t.y)));
    });
    results.select = summary(click);

    // 4. keyboard: set a pathology / FDI digits on the selected box
    const keys: number[] = [];
    // Opt-in trace of the layout events of the keyboard scenario: how many of the page's layout objects each one touched.
    const traceKeys = process.env.E2E_PERF_TRACE === "1";
    if (traceKeys) await browser.startTracing(page, { categories: ["devtools.timeline"] });
    await work("keys", 20, async () => {
      for (let i = 0; i < 20; i++) keys.push(await frameAfter(page, () => page.keyboard.press(`Alt+Digit${1 + (i % 4)}`)));
    });
    results.keys = summary(keys);

    if (traceKeys) {
      type Ev = { name: string; dur?: number; args?: { beginData?: { dirtyObjects?: number; totalObjects?: number; partialLayout?: boolean } } };
      const trace = JSON.parse((await browser.stopTracing()).toString()) as { traceEvents: Ev[] };
      const layouts = trace.traceEvents.filter((e) => e.name === "Layout" && e.dur);
      results.keysLayouts = layouts.slice(0, 12).map((e) => ({ ms: +((e.dur ?? 0) / 1000).toFixed(1), dirty: e.args?.beginData?.dirtyObjects, total: e.args?.beginData?.totalObjects, partial: e.args?.beginData?.partialLayout }));
    }

    // 5. a change from the table (a native select inside a 500-row table)
    const sel: number[] = [];
    // earlier selections scrolled the windowed table: bring box 5's row back into the window
    await page.getByRole("table").evaluate((t) => { (t.parentElement as HTMLElement).scrollTop = 0; });
    await expect(page.getByRole("combobox", { name: "Pathology for box 5", exact: true })).toBeVisible();
    await work("tableSelect", 10, async () => {
      for (let i = 0; i < 10; i++) sel.push(await frameAfter(page, async () => void (await page.getByRole("combobox", { name: "Pathology for box 5", exact: true }).selectOption(i % 2 ? "Impacted" : "Caries"))));
    });
    results.tableSelect = summary(sel);

    const perf = await page.evaluate(() => (window as unknown as { __perf: { loaf: number[]; blocking: number[]; events: number[] } }).__perf);
    results.longAnimationFrames = { count: perf.loaf.length, ...summary(perf.loaf), blockingTotalMs: Math.round(perf.blocking.reduce((a, c) => a + c, 0)) };
    results.slowEvents = summary(perf.events);
    results.domNodes = await page.evaluate(() => document.getElementsByTagName("*").length);

    mkdirSync("perf-results", { recursive: true });
    writeFileSync(`perf-results/editor-${LABEL}-${n}.json`, JSON.stringify(results, null, 2));
    console.log(`PERF ${LABEL} ${n} ${JSON.stringify({ ...results, dragTop: undefined })}`);
    console.log(`PERFTOP ${LABEL} ${n} ${JSON.stringify(top)}`);
    await ctx.close();
  });
}
