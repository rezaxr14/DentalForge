#!/usr/bin/env node
/**
 * `pnpm smoke:prod -- <url>` — verify a deployed build, not a local one.
 *
 * HTTP: every key page and API answers without a 5xx, `/api/labels/status` is
 * 200 signed out, worker endpoints reject a missing token, the security
 * headers are present (exactly one CSP header), and three demo images plus
 * three tool renders load as non-empty images.
 *
 * Browser (Playwright against the same URL): six pages must have a strict
 * console (no page errors, console.error, failed same-origin requests or 5xx),
 * zero `securitypolicyviolation` events, and exactly one CSP header. axe-core
 * runs on three pages with no exclusions.
 *
 * Usage: pnpm smoke:prod -- https://your-deployment.example
 */
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const raw = process.argv[2];
if (!raw) {
  console.error("usage: pnpm smoke:prod -- <url>");
  process.exit(2);
}
const base = raw.replace(/\/+$/, "");
if (!/^https?:\/\//i.test(base)) {
  console.error(`smoke:prod: <url> must start with http:// or https:// (got ${raw})`);
  process.exit(2);
}

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failures += 1;
}

const HTTP_TIMEOUT = 30_000;
async function http(path, init = {}) {
  return fetch(base + path, {
    redirect: "manual",
    signal: AbortSignal.timeout(HTTP_TIMEOUT),
    ...init,
  });
}

const BAD_BODY = [/Application error/i, /Internal Server Error/i, /__next_error__/];

async function checkPage(path) {
  const res = await http(path);
  const redirectOk = [301, 302, 303, 307, 308].includes(res.status);
  const body = res.status === 200 ? await res.text() : "";
  const bad = BAD_BODY.find((re) => re.test(body));
  check(
    `GET ${path} → ${res.status} (not a 5xx)`,
    res.status < 500 && !bad,
    bad ? `body matched ${bad}` : "",
  );
  return redirectOk;
}

async function sampleHref(listing, prefix) {
  try {
    const res = await http(listing);
    if (res.status !== 200) return null;
    const html = await res.text();
    const m = new RegExp(`href="${prefix}/([^"/?#]+)"`).exec(html);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

async function checkApis() {
  const health = await http("/api/health");
  let healthBody = {};
  try {
    healthBody = await health.json();
  } catch {
    /* reported below */
  }
  check(
    "GET /api/health 200 and reports its real state",
    health.status === 200 && ["ok", "degraded"].includes(healthBody.status),
    `${health.status} ${JSON.stringify(healthBody)}`,
  );

  const workerStatus = await http("/api/worker/status");
  check("GET /api/worker/status 200", workerStatus.status === 200, `${workerStatus.status}`);

  const spec = await http("/api/worker/v1/openapi.json");
  let openapi = {};
  try {
    openapi = await spec.json();
  } catch {
    /* reported below */
  }
  check(
    "GET /api/worker/v1/openapi.json is OpenAPI 3.1",
    spec.status === 200 && openapi.openapi === "3.1.0",
    `${spec.status} ${JSON.stringify(openapi.openapi)}`,
  );

  const labelStatus = await http("/api/labels/status");
  check("GET /api/labels/status signed out → 200", labelStatus.status === 200, `${labelStatus.status}`);

  const jobs = await http("/api/jobs");
  check("GET /api/jobs signed out → 401", jobs.status === 401, `${jobs.status}`);

  const workerPost = (path) =>
    http(path, {
      method: "POST",
      // The contract version comes before the token in the documented auth order
      // (worker-auth.ts), so send a valid version and prove the missing TOKEN is
      // what the endpoint rejects.
      headers: { "content-type": "application/json", "x-contract-version": "1" },
      body: "{}",
    });
  const workerCalls = [
    ["POST /api/worker/v1/register (no headers)", () => http("/api/worker/v1/register", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), [400, 401]],
    ["POST /api/worker/v1/heartbeat (no token)", () => workerPost("/api/worker/v1/heartbeat"), [401]],
    ["POST /api/worker/v1/jobs/claim (no token)", () => workerPost("/api/worker/v1/jobs/claim"), [401]],
    ["POST /api/worker/v1/ingest/traces (no token)", () => workerPost("/api/worker/v1/ingest/traces"), [401]],
    ["POST /api/worker/v1/models/register (no token)", () => workerPost("/api/worker/v1/models/register"), [401]],
    [
      "GET /api/worker/v1/images (no token)",
      () => http("/api/worker/v1/images", { headers: { "x-contract-version": "1" } }),
      [401],
    ],
  ];
  for (const [label, call, expected] of workerCalls) {
    const res = await call();
    const problem = (res.headers.get("content-type") ?? "").includes("problem+json");
    check(
      `${label} → ${expected.join("/")} problem+json`,
      expected.includes(res.status) && problem,
      `${res.status} ${res.headers.get("content-type")}`,
    );
  }

  const unsigned = await http("/api/storage/org/x.png");
  check("GET /api/storage/… without a signature → 403", unsigned.status === 403, `${unsigned.status}`);
  const unsignedPut = await http("/api/storage/org/x.png", { method: "PUT", body: "x" });
  check("PUT /api/storage/… without a signature → 403", unsignedPut.status === 403, `${unsignedPut.status}`);
}

const DEMO_IMAGES = [
  "/demo-assets/images/dentex-1-full.jpg",
  "/demo-assets/images/dentex-100-full.jpg",
  "/demo-assets/images/dentex-162-full.jpg",
];
const DEMO_RENDERS = [
  "/demo-assets/artifacts/255_turn11_i0.jpg",
  "/demo-assets/artifacts/255_turn12_i0.jpg",
  "/demo-assets/artifacts/255_turn13_i0.jpg",
];

async function checkAssets() {
  for (const [kind, paths] of [
    ["demo image", DEMO_IMAGES],
    ["tool render", DEMO_RENDERS],
  ]) {
    for (const path of paths) {
      const res = await http(path);
      const bytes = res.status === 200 ? (await res.arrayBuffer()).byteLength : 0;
      check(
        `${kind} ${path} → 200 image/* with bytes`,
        res.status === 200 &&
          (res.headers.get("content-type") ?? "").startsWith("image/") &&
          bytes > 0,
        `${res.status} ${res.headers.get("content-type")} ${bytes} bytes`,
      );
    }
  }
}

function watchPage(page) {
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console.error: ${m.text()} @ ${m.location().url}`);
  });
  page.on("requestfailed", async (r) => {
    if (!r.url().startsWith(base)) return;
    const error = r.failure()?.errorText ?? "";
    if (error === "net::ERR_ABORTED") {
      if (r.url().includes("_rsc=")) return;
      const res = await r.response().catch(() => null);
      if (res && res.status() < 400) return;
    }
    problems.push(`requestfailed: ${r.method()} ${r.url()} ${error}`);
  });
  page.on("response", (r) => {
    if (r.url().startsWith(base) && r.status() >= 500) {
      problems.push(`5xx: ${r.status()} ${r.request().method()} ${r.url()}`);
    }
  });
  return problems;
}

const BROWSER_PAGES = ["/", "/traces", "/evals", "/training", "/agent", "/about-data"];
const AXE_PAGES = ["/", "/traces", "/about-data"];

async function checkBrowser(browser) {
  const context = await browser.newContext();
  try {
    for (const path of BROWSER_PAGES) {
      const page = await context.newPage();
      const problems = watchPage(page);
      await page.addInitScript(() => {
        window.__csp = [];
        document.addEventListener("securitypolicyviolation", (e) => {
          window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
        });
      });
      const res = await page.goto(base + path, { waitUntil: "load", timeout: 45_000 });
      await page.waitForTimeout(3_000);
      const status = res?.status() ?? 0;
      const body = await page.content();
      const bad = BAD_BODY.find((re) => re.test(body));
      check(`browser ${path} → ${status} (not a 5xx)`, status < 500 && !bad, bad ? `body matched ${bad}` : "");

      const cspHeaders = (await res?.headersArray())?.filter(
        (h) => h.name.toLowerCase() === "content-security-policy",
      ) ?? [];
      check(`browser ${path} sends exactly one CSP header`, cspHeaders.length === 1, String(cspHeaders.length));
      const csp = cspHeaders[0]?.value ?? "";
      check(
        `browser ${path} CSP keeps frame-ancestors/object-src locked down`,
        csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'"),
        csp,
      );
      check(
        `browser ${path} sends nosniff and DENY`,
        res?.headers()["x-content-type-options"] === "nosniff" &&
          res?.headers()["x-frame-options"] === "DENY",
        `${res?.headers()["x-content-type-options"]} / ${res?.headers()["x-frame-options"]}`,
      );

      const violations = await page.evaluate(() => window.__csp ?? []);
      check(`browser ${path} has no CSP violations`, violations.length === 0, violations.join("; "));
      check(`browser ${path} has a clean console`, problems.length === 0, problems.join("; "));
      await page.close();
    }

    for (const path of AXE_PAGES) {
      const page = await context.newPage();
      await page.goto(base + path, { waitUntil: "load", timeout: 45_000 });
      await page.waitForTimeout(3_000);
      const { violations } = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      check(
        `axe ${path} has no WCAG A/AA violations`,
        violations.length === 0,
        violations
          .map((v) => `${v.id} [${v.impact}] x${v.nodes.length}: ${v.help}`)
          .join("; "),
      );
      await page.close();
    }
  } finally {
    await context.close();
  }
}

console.log(`smoke:prod against ${base}`);

console.log("\n[pages]");
const pages = ["/", "/traces", "/evals", "/training", "/agent", "/about-data", "/labels/1", "/status", "/invite/bogus-token"];
const traceId = await sampleHref("/traces", "/traces");
const evalId = await sampleHref("/evals", "/evals");
if (traceId) pages.push(`/traces/${traceId}`);
if (evalId) pages.push(`/evals/${evalId}`);
for (const path of pages) await checkPage(path);

console.log("\n[apis]");
await checkApis();

console.log("\n[assets]");
await checkAssets();

console.log("\n[browser]");
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM_PATH || undefined,
  args: (process.env.PW_CHROMIUM_ARGS ?? "").split(/\s+/).filter(Boolean),
});
try {
  await checkBrowser(browser);
} finally {
  await browser.close();
}

console.log(
  failures === 0 ? "\nsmoke:prod: all checks passed" : `\nsmoke:prod: ${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
