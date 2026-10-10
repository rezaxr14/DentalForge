#!/usr/bin/env node
/**
 * `pnpm smoke` — degradation smoke test (plan §9.5), HTTP level.
 *
 * Boots the PRODUCTION build (`next start`) in four deployment shapes and
 * visits EVERY page and the key API routes, asserting that the app serves, never
 * 5xx's on an expected condition, and shows no error-boundary markers:
 *
 *   A  database unreachable, WORKER_MODE=off     (Vercel, nothing attached yet)
 *   B  database unreachable, WORKER_MODE=live    (worker configured, DB down)
 *   C  database up,          WORKER_MODE=live    (no worker has registered)
 *   D  insecure/incomplete production config     (must fail CLOSED, but diagnosably)
 *
 * Requires `next build` first. C needs Postgres at SMOKE_DATABASE_URL
 * (default: the docker-compose database) and is skipped with a notice otherwise.
 * This is not a browser test: console-error and visual checks need Playwright.
 */
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const root = process.cwd();
const APP = join(root, "src", "app");
// Windows: `node_modules/.bin/next` is an extensionless sh script that spawn()
// cannot execute without a shell — invoke the JS entry via the node binary.
const NEXT_BIN = join(root, "node_modules", "next", "dist", "bin", "next");
const DB_URL = process.env.SMOKE_DATABASE_URL ?? "postgresql://traceforge:traceforge@localhost:5433/traceforge";
const DEAD_DB = "postgresql://nobody:nobody@127.0.0.1:1/none";
const SECRETS = {
  BETTER_AUTH_SECRET: "smoke-test-secret-0123456789-abcdefghijklmnop",
  INVITE_SIGNING_SECRET: "smoke-invite-secret-0123456789",
};

function pagesUnder(dir, segs = []) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "api") continue;
      const isGroup = name.startsWith("(") && name.endsWith(")");
      out.push(...pagesUnder(p, isGroup ? segs : [...segs, name]));
    } else if (name === "page.tsx") {
      out.push("/" + segs.join("/"));
    }
  }
  return out;
}
const PAGES = pagesUnder(APP).sort();

async function dbReachable(url) {
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 1500 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failures += 1;
}

async function startServer(env, port) {
  const child = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(port)], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      return { child, base, log: () => log };
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  child.kill("SIGKILL");
  throw new Error(`server did not start:\n${log}`);
}

const get = (base, path, init = {}) => fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(20_000), ...init });
const BAD_BODY = [/Application error/i, /Internal Server Error/i, /__next_error__/];

async function sampleParam(base, listing, hrefPrefix, fallback) {
  try {
    const html = await (await get(base, listing)).text();
    const m = new RegExp(`href="${hrefPrefix}/([^"/?#]+)"`).exec(html);
    return m ? decodeURIComponent(m[1]) : fallback;
  } catch {
    return fallback;
  }
}

async function visitPages(base) {
  const samples = {
    "/traces/[id]": await sampleParam(base, "/traces", "/traces", "1"),
    "/evals/[id]": await sampleParam(base, "/evals", "/evals", "1"),
    "/labels/[imageId]": "1",
    "/invite/[token]": "bogus-token",
  };
  for (const route of PAGES) {
    const dyn = /\[(\w+)\]/.exec(route);
    const key = dyn ? route : null;
    const url = dyn ? route.replace(/\[\w+\]/, samples[key] ?? "1") : route;
    const res = await get(base, url);
    const body = res.status === 200 ? await res.text() : "";
    const redirectOk = [307, 308].includes(res.status) && /sign-in/.test(res.headers.get("location") ?? "");
    const bad = BAD_BODY.find((re) => re.test(body));
    check(`GET ${url} → ${res.status}`, (res.status === 200 || redirectOk) && !bad, bad ? `body matched ${bad}` : "");
    if (dyn) {
      const bogus = await get(base, route.replace(/\[\w+\]/, "does-not-exist-" + Date.now()));
      check(`GET ${route.replace(/\[\w+\]/, "<unknown>")} → ${bogus.status} (not a 5xx)`, bogus.status < 500);
    }
  }
}

async function api(base, { dbUp, mode }) {
  const health = await get(base, "/api/health");
  const h = await health.json();
  check("GET /api/health 200 and honest about the database", health.status === 200 && h.db === (dbUp ? "up" : "down") && h.workerMode === mode, JSON.stringify(h));
  check("  health.status is `ok` with a DB and `degraded` without", h.status === (dbUp ? "ok" : "degraded"));
  check("  health.redis is absent (polling mode) and storage is local", h.redis === "absent" && h.storage === "local");

  const ws = await get(base, "/api/worker/status");
  const w = await ws.json();
  check("GET /api/worker/status 200, worker offline (nobody registered)", ws.status === 200 && w.status === "offline", JSON.stringify(w));

  const spec = await get(base, "/api/worker/v1/openapi.json");
  const doc = await spec.json();
  check("GET /api/worker/v1/openapi.json is OpenAPI 3.1", spec.status === 200 && doc.openapi === "3.1.0");

  const reg = await get(base, "/api/worker/v1/register", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (dbUp) {
    const p = await reg.json();
    check("POST /api/worker/v1/register without headers → 400 problem+json", reg.status === 400 && reg.headers.get("content-type")?.includes("problem+json") && p.code === "invalid_request", `${reg.status} ${JSON.stringify(p)}`);
    const tok = await get(base, "/api/worker/v1/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-contract-version": "1", authorization: "Bearer tf_wrk_not-a-real-token" },
      body: "{}",
    });
    check("  unknown token → 401 (not 500)", tok.status === 401);
    const jobs = await get(base, "/api/jobs");
    check("GET /api/jobs signed out → 401", jobs.status === 401);
  } else {
    check("POST /api/worker/v1/register with DB down → 503 + Retry-After (a worker keeps polling)", reg.status === 503 && Boolean(reg.headers.get("retry-after")), `${reg.status}`);
    const jobs = await get(base, "/api/jobs");
    check("GET /api/jobs with DB down → 503 (not a crash)", jobs.status === 503, `${jobs.status}`);
  }

  const unsigned = await get(base, "/api/storage/org/x.png");
  check("GET /api/storage/… without a signature → 403", unsigned.status === 403, `${unsigned.status}`);
  const put = await get(base, "/api/storage/org/x.png", { method: "PUT", body: "x" });
  check("PUT /api/storage/… without a signature → 403", put.status === 403, `${put.status}`);
}

async function variant(name, env, expect) {
  console.log(`\n[${name}]`);
  const port = 3200 + Math.floor(Math.random() * 600);
  const srv = await startServer({ ...env, BETTER_AUTH_URL: `http://127.0.0.1:${port}` }, port);
  try {
    if (expect.misconfigured) {
      const res = await get(srv.base, "/api/health");
      const body = await res.json();
      check("GET /api/health → 503 `misconfigured` naming the variables", res.status === 503 && body.status === "misconfigured" && body.problems.length > 0, JSON.stringify(body));
      check("  …and never echoes a secret value", !JSON.stringify(body).includes("dev-only") && !JSON.stringify(body).includes(SECRETS.BETTER_AUTH_SECRET));
      const status = await get(srv.base, "/status");
      const html = await status.text();
      check("GET /status renders the misconfiguration (no crash)", status.status === 200 && /Misconfigured deployment/.test(html));
      await visitPages(srv.base); // static pages must still serve
    } else {
      await visitPages(srv.base);
      await api(srv.base, expect);
    }
  } finally {
    srv.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
  }
}

const dbUp = await dbReachable(DB_URL);
console.log(`pages under test (${PAGES.length}): ${PAGES.join("  ")}`);
await variant("A: DB down, WORKER_MODE=off", { ...SECRETS, DATABASE_URL: DEAD_DB, WORKER_MODE: "off" }, { dbUp: false, mode: "off" });
await variant("B: DB down, WORKER_MODE=live", { ...SECRETS, DATABASE_URL: DEAD_DB, WORKER_MODE: "live" }, { dbUp: false, mode: "live" });
if (dbUp) await variant("C: DB up, WORKER_MODE=live, no worker", { ...SECRETS, DATABASE_URL: DB_URL, WORKER_MODE: "live" }, { dbUp: true, mode: "live" });
else console.log(`\n[C] SKIPPED: no Postgres at ${DB_URL.replace(/:[^:@/]*@/, ":***@")}`);
await variant("D: insecure production config (fails closed, diagnosably)", { WORKER_MODE: "live" }, { misconfigured: true });

console.log(failures === 0 ? "\nsmoke: all checks passed" : `\nsmoke: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
