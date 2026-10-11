#!/usr/bin/env node
/**
 * `pnpm e2e:worker` — end-to-end proof of the worker pipeline against a REAL
 * production server and REAL Postgres (needs `next build` + a database).
 *
 *   signs up a user and creates an org through Better Auth → mints a worker
 *   token → enqueues every job type through the session-authenticated API →
 *   the TypeScript mock worker claims, streams, uploads artifacts and completes
 *   → SSE is read end to end → a running job is cancelled mid-flight → the
 *   Python reference worker (a second language) handles a job on the same wire.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const root = process.cwd();
const DB_URL = process.env.SMOKE_DATABASE_URL ?? "postgresql://traceforge:traceforge@localhost:5433/traceforge";
const PORT = 3400 + Math.floor(Math.random() * 400);
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now().toString(36);
const EMAIL = `e2e-${stamp}@example.com`;
const SLUG = `e2e-${stamp}`;
// Windows: `node_modules/.bin/next` and `.bin/tsx` are extensionless sh scripts
// that spawn() cannot execute without a shell, so invoke the JS entry points
// through the current node binary instead. Python: `python3` is only a Microsoft
// Store alias on Windows; the real interpreter is on PATH as `python`.
const NEXT_BIN = join(root, "node_modules", "next", "dist", "bin", "next");
const TSX_BIN = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const PY = process.platform === "win32" ? "python" : "python3";
const ENV = {
  DATABASE_URL: DB_URL,
  BETTER_AUTH_URL: BASE,
  BETTER_AUTH_SECRET: "e2e-better-auth-secret-0123456789abcdefghij",
  INVITE_SIGNING_SECRET: "e2e-invite-secret-0123456789",
  WORKER_MODE: "live",
};

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const cleanups = [];

function run(cmd, args, env = {}, name = cmd) {
  const child = spawn(cmd, args, { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const proc = { child, out: "", name };
  child.stdout.on("data", (d) => (proc.out += d));
  child.stderr.on("data", (d) => (proc.out += d));
  children.push(proc);
  return proc;
}
const stop = async (proc) => {
  if (proc.child.exitCode === null) proc.child.kill("SIGTERM");
  for (let i = 0; i < 40 && proc.child.exitCode === null; i++) await sleep(250);
  if (proc.child.exitCode === null) proc.child.kill("SIGKILL");
};

async function waitFor(fn, { timeoutMs = 20_000, everyMs = 250 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(everyMs);
  }
}

let cookie = "";
const mergeCookies = (res) => {
  const jar = new Map(cookie.split("; ").filter(Boolean).map((c) => c.split(/=(.*)/s).slice(0, 2)));
  for (const sc of res.headers.getSetCookie()) {
    const [pair] = sc.split(";");
    const [k, v] = pair.split(/=(.*)/s);
    jar.set(k, v);
  }
  cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
};
const api = async (path, { method = "GET", body, headers = {} } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", origin: BASE, cookie, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  mergeCookies(res);
  return res;
};
const job = async (id) => (await (await api(`/api/jobs/${id}`)).json());
const enqueue = async (type, payload = {}) => {
  const res = await api("/api/jobs", { method: "POST", body: { type, payload } });
  const body = await res.json();
  if (res.status !== 201) throw new Error(`enqueue ${type} → ${res.status} ${JSON.stringify(body)}`);
  return body.id;
};
const finish = (id, timeoutMs = 25_000) => waitFor(async () => {
  const j = await job(id);
  return ["succeeded", "failed", "cancelled", "expired"].includes(j.status) ? j : null;
}, { timeoutMs });

async function readSse(path, timeoutMs = 25_000) {
  const res = await fetch(BASE + path, { headers: { cookie, accept: "text/event-stream" }, signal: AbortSignal.timeout(timeoutMs) });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let raw = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += dec.decode(value);
    if (raw.includes("event: end")) break;
  }
  await reader.cancel().catch(() => {});
  return raw;
}

async function main() {
  console.log(`e2e against ${BASE}`);
  const server = run(process.execPath, [NEXT_BIN, "start", "-p", String(PORT)], { ...ENV, NODE_ENV: "production" }, "next");
  const up = await waitFor(async () => {
    try { return (await fetch(`${BASE}/api/health`)).ok; } catch { return false; }
  }, { timeoutMs: 60_000, everyMs: 500 });
  if (!up) throw new Error(`server did not start:\n${server.out}`);
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check("server up with a real database", health.db === "up" && health.workerMode === "live", JSON.stringify(health));

  // ---- a real user + org through Better Auth ------------------------------
  const su = await api("/api/auth/sign-up/email", { method: "POST", body: { email: EMAIL, password: "e2e-password-123", name: "E2E User" } });
  check("sign up", su.ok, `${su.status}`);
  const org = await api("/api/auth/organization/create", { method: "POST", body: { name: "E2E Org", slug: SLUG } });
  const orgBody = await org.json();
  check("create organization (creator becomes admin)", org.ok && orgBody.slug === SLUG, `${org.status} ${JSON.stringify(orgBody).slice(0, 120)}`);
  const orgId = orgBody.id;
  cleanups.push(() => rmSync(join(root, "public", "demo-assets", orgId), { recursive: true, force: true }));
  const list = await api("/api/jobs");
  check("session resolves to an org member (GET /api/jobs → 200)", list.status === 200, `${list.status}`);

  // ---- a worker token via the real CLI ------------------------------------
  const tokRun = spawnSync(process.execPath, [TSX_BIN, "scripts/create-worker-token.ts", "--org", SLUG, "--name", "e2e"], {
    cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: DB_URL, BETTER_AUTH_SECRET: ENV.BETTER_AUTH_SECRET, INVITE_SIGNING_SECRET: ENV.INVITE_SIGNING_SECRET }, encoding: "utf8",
  });
  const token = /tf_wrk_[\w-]+/.exec(tokRun.stdout)?.[0];
  check("`pnpm worker:token` mints a token", Boolean(token), tokRun.stderr.slice(0, 200));
  if (!token) throw new Error("no token");

  // ---- nothing attached yet: the job waits, honestly ------------------------
  const early = await enqueue("system.ping", { message: "early", steps: 1 });
  await sleep(1500);
  check("with no worker the job stays queued (no crash, no loss)", (await job(early)).status === "queued");
  const noWorker = await (await api("/api/worker/status")).json();
  check("worker status is offline while nobody is attached", noWorker.status === "offline" && noWorker.workers.length === 0, JSON.stringify(noWorker));

  // ---- attach the TypeScript mock worker -----------------------------------
  const mock = run(process.execPath, [TSX_BIN, "examples/mock-worker/index.ts"], {
    TRACEFORGE_URL: BASE, TRACEFORGE_TOKEN: token, MOCK_STEP_DELAY_MS: "80", MOCK_CLAIM_WAIT_MS: "2000",
  }, "mock-worker");
  const earlyDone = await finish(early);
  check("the queued job runs as soon as a worker connects", earlyDone?.status === "succeeded" && earlyDone.result?.echo === "early", JSON.stringify(earlyDone?.result));

  const online = await waitFor(async () => {
    const s = await (await api("/api/worker/status")).json();
    return s.status === "online" ? s : null;
  });
  check("worker status flips to online and lists declared capabilities", online?.workers?.[0]?.name === "mock-worker" && online.workers[0].capabilities.includes("tool.execute"), JSON.stringify(online));

  // ---- SSE end to end --------------------------------------------------------
  const ping = await enqueue("system.ping", { message: "stream me", steps: 3 });
  const raw = await readSse(`/api/jobs/${ping}/events`);
  const evs = [...raw.matchAll(/event: (\w+)/g)].map((m) => m[1]);
  check("SSE delivers status, 3 progress events and `end`", evs.filter((e) => e === "progress").length === 3 && evs.includes("status") && evs.at(-1) === "end", evs.join(","));
  const pingDone = await finish(ping);
  check("ping result is validated and stored", pingDone.status === "succeeded" && pingDone.result.echo === "stream me" && pingDone.result.workerName === "mock-worker");
  const page = await (await api(`/api/jobs/${ping}/events?format=json&after=1`)).json();
  check("polling fallback resumes after a seq", page.events.map((e) => e.seq).join() === "2,3" && page.done === true, JSON.stringify(page.events.map((e) => e.seq)));

  // ---- every job type ----------------------------------------------------------
  const zoom = await enqueue("tool.execute", { imageId: 1, tool: "zoom_crop", args: { bbox: [10, 10, 100, 100] } });
  const zoomDone = await finish(zoom);
  check("tool.execute (image tool): artifact uploaded through the signed gateway", zoomDone?.status === "succeeded" && zoomDone.artifactIds.length === 1 && zoomDone.result.kind === "image", JSON.stringify(zoomDone));
  const stored = existsSync(join(root, "public", "demo-assets", orgId)) && readdirSync(join(root, "public", "demo-assets", orgId, "artifacts"), { recursive: true }).some((f) => String(f).endsWith("zoom_crop.png"));
  check("  …and the PNG really landed in the tenant-scoped key", stored);

  const fdi = await finish(await enqueue("tool.execute", { imageId: 1, tool: "fdi_label", args: { quadrant: 3, tooth_position: 6 } }));
  check("tool.execute fdi_label (pure math)", fdi?.status === "succeeded" && typeof fdi.result.data.label === "string", JSON.stringify(fdi?.result));
  const nudge = await finish(await enqueue("tool.execute", { imageId: 1, tool: "nudge_crop", args: { bbox: [100, 100, 200, 200], dx_frac: 0.5 } }));
  check("tool.execute nudge_crop (domain port)", nudge?.status === "succeeded" && nudge.result.data.bbox.length === 4, JSON.stringify(nudge?.result));
  const loc = await finish(await enqueue("tool.execute", { imageId: 1, tool: "locate_tooth", args: { tooth: 48 } }));
  check("tool.execute locate_tooth (real GT replay)", loc?.status === "succeeded" && loc.result.data.tooth === 48, JSON.stringify(loc?.result));
  const bad = await finish(await enqueue("tool.execute", { imageId: 1, tool: "locate_tooth", args: { tooth: 99 } }));
  check("non-retryable handler error → job `failed` with the reason, not retried forever", bad?.status === "failed" && bad.attempts === 1 && /not in the mock/.test(bad.error?.message ?? ""), JSON.stringify(bad?.error));

  const yolo = await finish(await enqueue("yolo.prelabel", { imageId: 1, modelId: "yolo_cv_best" }));
  check("yolo.prelabel returns real replayed boxes", yolo?.status === "succeeded" && yolo.result.boxes.length > 5 && yolo.result.boxes[0].classIdx >= 0, JSON.stringify(yolo?.result)?.slice(0, 120));
  const agent = await enqueue("agent.run", { imageId: 1, modelId: "demo", mode: "with_tools" });
  const agentRaw = await readSse(`/api/jobs/${agent}/events`);
  check("agent.run streams one `turn` event per turn over SSE", (agentRaw.match(/event: turn/g) ?? []).length === 4, `${(agentRaw.match(/event: turn/g) ?? []).length}`);
  const agentDone = await finish(agent);
  check("  …and completes with a schema-valid final answer", agentDone?.status === "succeeded" && agentDone.result.nTurns === 4 && Array.isArray(agentDone.result.finalAnswer), JSON.stringify(agentDone?.error));
  const ev = await finish(await enqueue("eval.run", { modelId: "kimi_k3", dataset: "dentex" }));
  check("eval.run", ev?.status === "succeeded" && ev.result.n === 1 && typeof ev.result.summary.fdi_f1 === "number", JSON.stringify(ev?.error ?? ev?.result));
  const al = await finish(await enqueue("al.score", { imageIds: [1, 2], modelId: "yolo_cv_best" }));
  check("al.score", al?.status === "succeeded" && al.result.scores.length === 2, JSON.stringify(al?.error));

  // ---- validation at the door ------------------------------------------------
  const invalid = await api("/api/jobs", { method: "POST", body: { type: "tool.execute", payload: { imageId: 1, tool: "rm_rf", args: {} } } });
  check("enqueue rejects an invalid payload (422) before it can reach a worker", invalid.status === 422, `${invalid.status}`);

  // ---- cancel a running job; the worker drops it ---------------------------------
  const slow = await enqueue("system.ping", { message: "cancel me", steps: 20 });
  await waitFor(async () => (await job(slow)).status === "running");
  const cancel = await api(`/api/jobs/${slow}/cancel`, { method: "POST" });
  check("cancel a running job", cancel.ok && (await cancel.json()).status === "cancelled", `${cancel.status}`);
  const dropped = await waitFor(async () => /dropped: job_cancelled/.test(mock.out), { timeoutMs: 15_000 });
  check("the worker sees 409 job_cancelled and drops it (no zombie work)", Boolean(dropped));
  check("  …and the cancelled job stays cancelled", (await job(slow)).status === "cancelled");

  // ---- a second language on the same wire ---------------------------------------
  await stop(mock);
  const py = run(PY, ["examples/python-worker/worker.py"], {
    TRACEFORGE_URL: BASE, TRACEFORGE_TOKEN: token, WORKER_NAME: "py-e2e", MAX_JOBS: "1", STEP_DELAY_S: "0.05",
  }, "python-worker");
  const pyJob = await enqueue("system.ping", { message: "from python", steps: 2 });
  const pyDone = await finish(pyJob, 30_000);
  check("Python reference worker completes a job on the same contract", pyDone?.status === "succeeded" && pyDone.result.workerName === "py-e2e" && pyDone.result.echo === "from python", `${JSON.stringify(pyDone)}\n${py.out}`);
  const pyExit = await waitFor(async () => py.child.exitCode !== null, { timeoutMs: 20_000 });
  check("  …and exits cleanly after MAX_JOBS", pyExit && py.child.exitCode === 0, py.out.slice(-300));

  // ---- capabilities are honest: the python worker only advertises what it can do ------
  const wantsAgent = await enqueue("agent.run", { imageId: 1, modelId: "demo", mode: "with_tools" });
  const py2 = run(PY, ["examples/python-worker/worker.py"], { TRACEFORGE_URL: BASE, TRACEFORGE_TOKEN: token, WORKER_NAME: "py-e2e", STEP_DELAY_S: "0.05" }, "python-worker-2");
  await sleep(4000);
  check("a worker that does not advertise agent.run is never handed one", (await job(wantsAgent)).status === "queued");
  await api(`/api/jobs/${wantsAgent}/cancel`, { method: "POST" });
  const sp = await (await api("/status")).text();
  check("/status page renders live workers and the resolved ladder", /py-e2e/.test(sp) && /Capability ladder/.test(sp) && /mock-worker/.test(sp));
  await stop(py2);

  // ---- models/register + ingest/metrics over real HTTP, then the rows in real Postgres ----
  const wpost = async (path, body, tok = token) => {
    const res = await fetch(`${BASE}/api/worker/v1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-contract-version": "1", authorization: `Bearer ${tok}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const m1 = await wpost("/models/register", { name: "e2e-qwen", kind: "vlm", stage: "sft", hfPath: "me/models/sft", meta: { rank: 16 } });
  const m2 = await wpost("/models/register", { name: "e2e-qwen", kind: "vlm", stage: "sft" });
  check("models/register creates, then the replay updates the same row", m1.status === 200 && m1.json.created === true && m2.json.created === false && m2.json.modelId === m1.json.modelId, JSON.stringify([m1.json, m2.json]));
  const mBad = await wpost("/models/register", { name: "x", kind: "vlm", stage: "yolo" });
  check("models/register rejects an inconsistent kind/stage with 422 problem+json", mBad.status === 422 && mBad.json.code === "validation_failed", JSON.stringify(mBad));

  const batch = {
    run: { kind: "grpo", name: "e2e-grpo", config: { k: 8 } },
    metrics: [{ step: 1, name: "loss", value: 0.1 }, { step: 2, name: "loss", value: 1 / 3 }],
    rewardSamples: [{ step: 1, trajectoryRef: "img1:g0:k0", components: { accuracy: 1 }, total: 0.1 }],
  };
  const i1 = await wpost("/ingest/metrics", batch);
  const i2 = await wpost("/ingest/metrics", batch);
  check("ingest/metrics creates the run and rows", i1.status === 200 && i1.json.runCreated && i1.json.metrics.inserted === 2 && i1.json.rewardSamples.inserted === 1, JSON.stringify(i1));
  check("  …and re-sending the same batch inserts nothing (idempotent)", i2.json.runId === i1.json.runId && i2.json.runCreated === false && i2.json.metrics.inserted === 0 && i2.json.rewardSamples.inserted === 0, JSON.stringify(i2));
  const dup = await wpost("/ingest/metrics", { ...batch, run: { kind: "sft", name: "e2e-dup" }, metrics: [batch.metrics[0], batch.metrics[0]] });
  check("ingest/metrics rejects duplicate keys in a batch with 422", dup.status === 422, JSON.stringify(dup));

  const dbp = new pg.Pool({ connectionString: DB_URL });
  try {
    const rows = await dbp.query(
      "SELECT m.step, m.name, m.value FROM training_metrics m JOIN training_runs r ON r.id = m.run_id JOIN organizations o ON o.id = r.org_id WHERE o.slug = $1 AND r.name = 'e2e-grpo' ORDER BY m.step",
      [SLUG],
    );
    check("the metric rows are really in Postgres as float32 (0.1 and 0.33333334)", rows.rows.length === 2 && rows.rows[0].value === 0.1 && rows.rows[1].value === 0.33333334, JSON.stringify(rows.rows));
    const abort = await dbp.query("SELECT count(*)::int AS n FROM training_runs r JOIN organizations o ON o.id = r.org_id WHERE o.slug = $1 AND r.name = 'e2e-dup'", [SLUG]);
    check("a rejected batch left no run behind", abort.rows[0].n === 0, JSON.stringify(abort.rows));
  } finally {
    await dbp.end();
  }

  // ---- ingest/traces: real fixture trace over HTTP into real Postgres ----
  const tp = new pg.Pool({ connectionString: DB_URL });
  try {
    // The dataset and its image must already exist (the endpoint never creates them): seed as the importer would.
    const ds = await tp.query("INSERT INTO datasets (id, org_id, name, source) VALUES (gen_random_uuid(), $1, 'DENTEX', 'dentex') RETURNING id", [orgId]);
    await tp.query(
      "INSERT INTO images (id, org_id, dataset_id, source_image_id, content_hash, width, height, storage_key) VALUES (gen_random_uuid(), $1, $2, 1, 'e2e-img-1', 100, 50, '')",
      [orgId, ds.rows[0].id],
    );
    const fixture = JSON.parse(readFileSync(join(root, "fixtures", "traces", "verified_with_tools.json"), "utf8"));
    const tbatch = { source: { cohort: "e2e_dentex", mode: "with_tools", sourceFile: "e2e" }, traces: [fixture, { ...fixture, image_id: 999 }] };
    const t1 = await wpost("/ingest/traces", tbatch);
    check(
      "ingest/traces inserts the known image and rejects the unknown one (per-item, HTTP 200)",
      t1.status === 200 && t1.json.inserted === 1 && t1.json.rejected === 1 && t1.json.results[0].outcome === "inserted" && t1.json.results[1].reason === "unknown_image",
      JSON.stringify(t1),
    );
    const t2 = await wpost("/ingest/traces", tbatch);
    check(
      "  …and re-sending it reports `existing` with the same content",
      t2.json.existing === 1 && t2.json.results[0].sameContent === true && t2.json.results[0].traceId === t1.json.results[0].traceId,
      JSON.stringify(t2),
    );
    const counts = await tp.query(
      `SELECT (SELECT count(*)::int FROM traces WHERE org_id = $1) AS traces,
              (SELECT count(*)::int FROM trace_turns WHERE org_id = $1) AS turns,
              (SELECT count(*)::int FROM tool_calls WHERE org_id = $1) AS calls`,
      [orgId],
    );
    const wantCalls = fixture.turns.reduce((n, t) => n + (t.tool_calls_this_turn?.length ?? 0), 0);
    check(
      "the trace, its turns and its tool calls are really in Postgres (once, not doubled by the replay)",
      counts.rows[0].traces === 1 && counts.rows[0].turns === fixture.turns.length && counts.rows[0].calls === wantCalls,
      JSON.stringify({ got: counts.rows[0], wantTurns: fixture.turns.length, wantCalls }),
    );
  } finally {
    await tp.end();
  }

  // ---- ingest/eval-run: a run uploaded in two chunks; summary recomputed from the stored cases ----
  const ep = new pg.Pool({ connectionString: DB_URL });
  try {
    const base = JSON.parse(readFileSync(join(root, "fixtures", "evals", "qwen.json"), "utf8"));
    const mkCase = (n) => ({ ...base, image_id: n, fdi_f1: n / 8, exact_f1: n / 16, format_ok: n % 2 === 0 });
    const c1 = await wpost("/ingest/eval-run", { runKey: "e2e-eval", cases: [1, 2, 3].map(mkCase) });
    const c2 = await wpost("/ingest/eval-run", { runKey: "e2e-eval", cases: [4, 5].map(mkCase) });
    check(
      "ingest/eval-run creates the run, then the second chunk extends it (n covers the whole run)",
      c1.status === 200 && c1.json.runCreated && c1.json.n === 3 && c2.json.runId === c1.json.runId && !c2.json.runCreated && c2.json.n === 5,
      JSON.stringify([c1, c2]),
    );
    const c3 = await wpost("/ingest/eval-run", { runKey: "e2e-eval", cases: [4, 5].map(mkCase) });
    check("  …and replaying a chunk inserts nothing", c3.json.cases.inserted === 0 && c3.json.n === 5, JSON.stringify(c3));
    const mism = await wpost("/ingest/eval-run", { runKey: "e2e-eval", cases: [{ ...mkCase(6), model: "another/model" }] });
    check("a reused runKey with a different model is 409 run_mismatch", mism.status === 409 && mism.json.code === "run_mismatch", JSON.stringify(mism));
    const rows = await ep.query(
      `SELECT r.n AS n, r.summary AS summary,
              (SELECT count(*)::int FROM eval_cases c WHERE c.run_id = r.id) AS stored,
              (SELECT avg(c.fdi_f1)::float8 FROM eval_cases c WHERE c.run_id = r.id) AS avg_fdi
         FROM eval_runs r JOIN organizations o ON o.id = r.org_id WHERE o.slug = $1 AND r.run_key = 'e2e-eval'`,
      [SLUG],
    );
    const got = rows.rows[0];
    check(
      "Postgres holds 5 cases and the stored summary equals the mean of the stored case rows",
      got && got.n === 5 && got.stored === 5 && Math.abs(got.summary.fdi_f1 - got.avg_fdi) < 1e-6 && got.summary.format_ok_rate === 2 / 5,
      JSON.stringify(got),
    );
  } finally {
    await ep.end();
  }
}

try {
  await main();
} catch (e) {
  failures += 1;
  console.error(`\nE2E ERROR: ${e.stack ?? e}`);
  for (const c of children) console.error(`--- ${c.name} output (tail)\n${c.out.slice(-1200)}`);
} finally {
  for (const c of children) await stop(c);
  for (const fn of cleanups) fn();
  const pool = new pg.Pool({ connectionString: DB_URL });
  try {
    await pool.query("DELETE FROM organizations WHERE slug = $1", [SLUG]);
    await pool.query("DELETE FROM users WHERE email = $1", [EMAIL]);
  } catch (e) {
    console.error("cleanup:", e.message);
  }
  await pool.end();
}
console.log(failures === 0 ? "\ne2e: all checks passed" : `\ne2e: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
