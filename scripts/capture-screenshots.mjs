/**
 * Capture the README screenshots from a running app.
 *
 *   node scripts/capture-screenshots.mjs [baseUrl]
 *
 * The app must be running with the demo data (DEMO_ORG_SLUG=demo,
 * TRACEFORGE_DATASOURCE=postgres). Output goes to docs/screenshots/.
 * It also fails on console errors and horizontal overflow, so a broken page
 * cannot silently become a screenshot.
 */
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = "docs/screenshots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const problems = [];

async function firstLink(page, prefix) {
  const href = await page.locator(`a[href^="${prefix}/"]`).first().getAttribute("href");
  if (!href) throw new Error(`no link under ${prefix}`);
  return href;
}

async function shot(name, path, { theme = "light", width = 1440, height = 900, fullPage = true } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
  });
  await context.addInitScript((t) => window.localStorage.setItem("theme", t), theme);
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`${name}: console ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`${name}: pageerror ${e.message}`));
  const res = await page.goto(BASE + path, { waitUntil: "networkidle" });
  if (!res || res.status() !== 200) problems.push(`${name}: HTTP ${res?.status()} for ${path}`);
  // Trigger lazy-loaded thumbnails before a full-page capture, then return to the top.
  await page.evaluate(async () => {
    const step = Math.max(400, window.innerHeight * 0.8);
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 80));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState("networkidle");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow > 2) problems.push(`${name}: horizontal overflow ${overflow}px`);
  const h1 = await page.locator("h1").first().innerText().catch(() => "");
  if (!h1) problems.push(`${name}: no visible h1`);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
  await context.close();
  return h1;
}

// Resolve real ids from the running demo instead of hard-coding them.
const probe = await browser.newContext();
const probePage = await probe.newPage();
await probePage.goto(`${BASE}/traces`, { waitUntil: "networkidle" });
const traceHref =
  (await probePage
    .locator('a[href^="/traces/"]')
    .filter({ hasText: "DENTEX case 255" })
    .filter({ hasText: "with tools" })
    .first()
    .getAttribute("href")) ?? (await firstLink(probePage, "/traces"));
await probePage.goto(`${BASE}/evals`, { waitUntil: "networkidle" });
const evalHref = await firstLink(probePage, "/evals");
await probe.close();

const titles = {};
titles.home = await shot("landing-light", "/");
titles.traces = await shot("traces-light", "/traces");
titles.trace = await shot("trace-detail-light", traceHref);
titles.evals = await shot("evals-light", "/evals");
titles.eval = await shot("eval-detail-light", evalHref);
titles.agent = await shot("agent-light", "/agent");
titles.training = await shot("training-light", "/training");
titles.about = await shot("about-data-light", "/about-data");
titles.homeDark = await shot("landing-dark", "/", { theme: "dark" });
titles.traceDark = await shot("trace-detail-dark", traceHref, { theme: "dark" });
titles.agentDark = await shot("agent-dark", "/agent", { theme: "dark" });
await shot("traces-mobile", "/traces", { width: 390, height: 844 });
await shot("trace-detail-mobile", traceHref, { width: 390, height: 844 });
await shot("agent-mobile", "/agent", { width: 390, height: 844 });

await browser.close();

console.log(JSON.stringify({ titles, problems }, null, 2));
if (problems.length) process.exitCode = 1;
