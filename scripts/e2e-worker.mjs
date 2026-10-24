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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  // Without this the pages read the committed FIXTURES even though every write below lands in
  // Postgres: the trace page then answers "Trace not found" for a trace the run just stored, which
  // is how the missing read-path proof hid. Production sets it; the e2e must mirror production.
  TRACEFORGE_DATASOURCE: "postgres",
  // ...and `resolveDataSource` resolves the org by this slug, so it must be THIS run's org, not
  // the default `demo`. Two env vars, both required, both read only by the read path.
  IMPORT_ORG_SLUG: SLUG,
  // Optional realtime bus (ADR-0015): with it the WHOLE pipeline below also runs on the bus-enabled code path.
  ...(process.env.E2E_REDIS_URL ? { REDIS_URL: process.env.E2E_REDIS_URL } : {}),
};
const REDIS = Boolean(process.env.E2E_REDIS_URL);

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
  check(
    REDIS ? "health reports the Redis bus as up" : "health reports no Redis bus (polling mode)",
    health.redis === (REDIS ? "up" : "absent"),
    JSON.stringify(health),
  );

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
    // Deterministic: a developer's shell may export a model file; this worker must advertise no agent.run.
    WORKER_MODELS_FILE: "",
  }, "python-worker");
  // Cold start of the venv Python (torch + ultralytics + YOLO weights) can outlast the old 30 s
  // window on a loaded machine, and a start-up timeout says nothing about the wire contract. Wait
  // for registration with its own budget, then give the JOB a fair one.
  const pyUp = await waitFor(async () => /registered as/.test(py.out), { timeoutMs: 90_000 });
  const pyJob = await enqueue("system.ping", { message: "from python", steps: 2 });
  const pyDone = await finish(pyJob, 30_000);
  check("Python reference worker completes a job on the same contract", Boolean(pyUp) && pyDone?.status === "succeeded" && pyDone.result.workerName === "py-e2e" && pyDone.result.echo === "from python", `${JSON.stringify(pyDone)}\n${py.out}`);
  const pyExit = await waitFor(async () => py.child.exitCode !== null, { timeoutMs: 20_000 });
  check("  …and exits cleanly after MAX_JOBS", pyExit && py.child.exitCode === 0, py.out.slice(-300));

  // ---- capabilities are honest: the python worker only advertises what it can do ------
  const wantsAgent = await enqueue("agent.run", { imageId: 1, modelId: "demo", mode: "with_tools" });
  const py2 = run(PY, ["examples/python-worker/worker.py"], {
    TRACEFORGE_URL: BASE, TRACEFORGE_TOKEN: token, WORKER_NAME: "py-e2e", STEP_DELAY_S: "0.05",
    WORKER_MODELS_FILE: "",
  }, "python-worker-2");
  await sleep(4000);
  check("a worker that registers no model never advertises agent.run", (await job(wantsAgent)).status === "queued");
  await api(`/api/jobs/${wantsAgent}/cancel`, { method: "POST" });
  const sp = await (await api("/status")).text();
  check("/status page renders live workers and the resolved ladder", /py-e2e/.test(sp) && /Capability ladder/.test(sp) && /mock-worker/.test(sp));
  await stop(py2);

  // ---- real handlers: tool.execute through VLM-DENTAL's actual tools, validated by the real server ----
  // Opt-in (CI has no research package): E2E_DENTAL_AGENT_PATH=/path/to/VLM-DENTAL (needs Pillow, numpy, scipy,
  // scikit-image, huggingface_hub in the Python environment). The server validates every result against the
  // contract schema on /complete, so a green run here means the wire format is right, not just the unit shapes.
  if (process.env.E2E_DENTAL_AGENT_PATH) {
    const dp = new pg.Pool({ connectionString: DB_URL });
    try {
      const keyRel = `${orgId}/images/e2e-pano.png`;
      const pngPath = join(root, "public", "demo-assets", keyRel);
      mkdirSync(dirname(pngPath), { recursive: true });
      const gen = spawnSync(PY, ["-c", "import sys\nfrom PIL import Image\nimg = Image.new('RGB', (800, 400), (40, 40, 40))\nfor x in range(0, 800, 25):\n    for y in range(100, 300):\n        v = 40 + (x * 7 + y) % 200\n        img.putpixel((x, y), (v, v, v))\nimg.save(sys.argv[1])", pngPath], { encoding: "utf8" });
      check("seeded a real 800x400 PNG for the real-tool run", gen.status === 0 && existsSync(pngPath), gen.stderr);
      const dset = await dp.query("INSERT INTO datasets (id, org_id, name, source) VALUES (gen_random_uuid(), $1, 'E2E-DENTAL', 'dentex') RETURNING id", [orgId]);
      const img = await dp.query(
        "INSERT INTO images (id, org_id, dataset_id, source_image_id, content_hash, width, height, storage_key) VALUES (gen_random_uuid(), $1, $2, 77, 'e2e-pano', 800, 400, $3) RETURNING id",
        [orgId, dset.rows[0].id, keyRel],
      );
      const imageId = img.rows[0].id;
      const dental = run(PY, ["examples/python-worker/worker.py"], {
        TRACEFORGE_URL: BASE, TRACEFORGE_TOKEN: token, WORKER_NAME: "py-dental", PYTHONPATH: process.env.E2E_DENTAL_AGENT_PATH,
        WORKER_MODELS_FILE: "",
      }, "python-dental-worker");
      await waitFor(async () => /registered as/.test(dental.out), { timeoutMs: 30_000 });
      const adv = /advertising \[([^\]]*)\]/.exec(dental.out)?.[1] ?? "";
      check("the dental worker advertises tool.execute (and only what it can run)", adv.includes("tool.execute") && !adv.includes("agent.run") && !adv.includes("eval.run"), dental.out.slice(-400));

      const zoom = await finish(await enqueue("tool.execute", { imageId, tool: "zoom_crop", args: { bbox: [100, 120, 80, 100] } }), 40_000);
      // A real image tool must leave a PNG behind; the storage key is generated by the gateway, so
      // this looks for the tool-named file rather than pretending to know the key.
      const artifactOnDisk = () => existsSync(join(root, "public", "demo-assets", orgId, "artifacts")) && readdirSync(join(root, "public", "demo-assets", orgId, "artifacts"), { recursive: true }).some((f) => String(f).includes("zoom_crop_") || String(f).includes("window_level_"));
      check("real zoom_crop: succeeded, image result with a stored PNG artifact", zoom?.status === "succeeded" && zoom.result.kind === "image" && zoom.result.width > 0 && zoom.result.artifactId && artifactOnDisk(), JSON.stringify(zoom));
      const win = await finish(await enqueue("tool.execute", { imageId, tool: "window_level", args: { preset: "bone" }, view: "canonical" }), 40_000);
      check("real window_level, canonical view: the 1536x768 FULL canvas", win?.status === "succeeded" && win.result.width === 1536 && win.result.height === 768, JSON.stringify(win));
      const fdi36 = await finish(await enqueue("tool.execute", { imageId, tool: "fdi_label", args: { quadrant: 3, tooth_position: 6 } }), 40_000);
      check("real fdi_label: data result \"36\"", fdi36?.status === "succeeded" && fdi36.result.kind === "data" && fdi36.result.data === "36", JSON.stringify(fdi36));
      const noGround = await finish(await enqueue("tool.execute", { imageId, tool: "locate_tooth", args: { tooth: 38 } }), 40_000);
      // Capability-aware, like the worker itself: on a machine WITHOUT the weights the guard must
      // refuse instead of inventing a box; on one WITH them the tool must actually run. Assuming
      // "no weights here" made this check fail on the GPU box.
      if (adv.includes("yolo.prelabel")) {
        check(
          "locate_tooth with grounding weights runs (a real box or a tool-level 'not found'), never the guard",
          noGround?.status === "succeeded" && noGround.result?.kind === "data" && !/grounding weights/.test(JSON.stringify(noGround)),
          JSON.stringify(noGround),
        );
      } else {
        check("locate_tooth without grounding weights fails the job instead of inventing a box", noGround?.status === "failed" && /grounding weights/.test(JSON.stringify(noGround)), JSON.stringify(noGround));
        check("  …and it is not retried: one attempt, although more were allowed", noGround?.attempts === 1 && noGround.maxAttempts > 1, JSON.stringify(noGround));
      }
      await stop(dental);
      // The later ingest checks look up "the" image of this org; leave no trace of this section.
      await dp.query("DELETE FROM images WHERE id = $1", [imageId]);
      await dp.query("DELETE FROM datasets WHERE id = $1", [dset.rows[0].id]);
    } finally {
      await dp.end();
    }
  } else {
    console.log("  note real-handler checks NOT run (set E2E_DENTAL_AGENT_PATH to the VLM-DENTAL checkout to run them)");
  }

  // ---- a live agent.run on the local test backend (LM Studio), opt-in --------------------------
  // E2E_LIVE_AGENT=1 + E2E_DENTAL_AGENT_PATH=<VLM-DENTAL checkout> + a model loaded in LM Studio.
  // WORKER_OPENAI_BASE_URL defaults to http://localhost:1234/v1; E2E_LIVE_AGENT_MODEL is the model
  // name LM Studio serves. Single image, single run: the heavy-run gate in the plan allows this.
  if (process.env.E2E_LIVE_AGENT) {
    if (!process.env.E2E_DENTAL_AGENT_PATH) {
      check("live agent.run needs E2E_DENTAL_AGENT_PATH (the VLM-DENTAL checkout)", false);
    } else {
      const modelName = process.env.E2E_LIVE_AGENT_MODEL ?? "qwen3.5-4b";
      const baseUrl = process.env.WORKER_OPENAI_BASE_URL ?? "http://localhost:1234/v1";
      const dp = new pg.Pool({ connectionString: DB_URL });
      let live;
      try {
        const keyRel = `${orgId}/images/e2e-live.png`;
        const pngPath = join(root, "public", "demo-assets", keyRel);
        mkdirSync(dirname(pngPath), { recursive: true });
        // A REAL radiograph is what makes a small test model actually reach for a tool: given a noise
        // mosaic it (correctly) found nothing worth zooming into and answered in one turn with zero
        // tool calls, which proves nothing about the artifact path. E2E_LIVE_AGENT_IMAGE wins;
        // otherwise the checkout's DENTEX validation panorama; otherwise a synthetic mosaic, and the
        // artifact checks print a visible note instead of pretending a model behaved.
        const dentexDefault = join(
          process.env.E2E_DENTAL_AGENT_PATH,
          "data", "dentex", "DENTEX", "validation_data", "quadrant_enumeration_disease", "xrays", "val_18.png",
        );
        const liveSource = [process.env.E2E_LIVE_AGENT_IMAGE, dentexDefault].find((p) => p && existsSync(p)) ?? null;
        const genCode = liveSource
          ? "import sys\nfrom PIL import Image\nimg = Image.open(sys.argv[1]).convert('RGB')\nimg.save(sys.argv[2])\nprint(img.width, img.height)"
          : "import sys\nfrom PIL import Image\nimg = Image.new('RGB', (800, 400), (30, 30, 30))\nfor x in range(0, 800, 20):\n    for y in range(80, 320):\n        v = 30 + (x * 5 + y * 3) % 220\n        img.putpixel((x, y), (v, v, v))\nimg.save(sys.argv[1])\nprint(img.width, img.height)";
        const gen = spawnSync(PY, ["-c", genCode, ...(liveSource ? [liveSource, pngPath] : [pngPath])], { encoding: "utf8" });
        const [imgW, imgH] = (gen.stdout ?? "").trim().split(/\s+/).map(Number);
        check(
          liveSource
            ? "seeded a real radiograph for the live run"
            : "seeded a synthetic 800x400 PNG for the live run (no E2E_LIVE_AGENT_IMAGE / DENTEX panorama found)",
          gen.status === 0 && existsSync(pngPath) && imgW > 0 && imgH > 0,
          gen.stderr,
        );
        // `upload` on purpose: /ingest/traces resolves a dataset by its SOURCE, and the ingest checks
        // later seed a `dentex` dataset. A second `dentex` dataset here would make that resolution
        // ambiguous (first row wins) and reject their known image.
        const dset = await dp.query("INSERT INTO datasets (id, org_id, name, source) VALUES (gen_random_uuid(), $1, 'E2E-LIVE', 'upload') RETURNING id", [orgId]);
        const img = await dp.query(
          "INSERT INTO images (id, org_id, dataset_id, source_image_id, content_hash, width, height, storage_key) VALUES (gen_random_uuid(), $1, $2, 902, 'e2e-live', $3, $4, $5) RETURNING id",
          [orgId, dset.rows[0].id, imgW, imgH, keyRel],
        );
        const imageId = img.rows[0].id;
        // The worker reads ground truth from an already-imported trace and refuses to run without it.
        // This row is an E2E FIXTURE (cohort `e2e_fixture`), not a DENTEX label: the run under test is
        // "does a live trace carry its provenance", not "is this the right diagnosis". The org and its
        // rows are deleted at the end of the run.
        const gt = [{ quadrant: 3, tooth_position: 8, diagnosis: "Caries", bbox: [300, 150, 80, 90] }];
        await dp.query(
          "INSERT INTO traces (id, org_id, dataset_id, image_id, cohort, mode, verified, content_hash, n_turns, n_tool_calls, format_ok, ground_truth, final_answer) VALUES (gen_random_uuid(), $1, $2, $3, 'e2e_fixture', 'with_tools', true, 'e2e-live-seed', 1, 0, true, $4, '[]')",
          [orgId, dset.rows[0].id, imageId, JSON.stringify(gt)],
        );

        const modelsFile = join(root, "public", "demo-assets", orgId, "worker-models.json");
        writeFileSync(modelsFile, JSON.stringify({
          models: [{ modelId: "live-test", backend: "openai_compat", stage: "test", basePath: modelName, notes: "e2e live run" }],
        }));
        live = run(PY, ["examples/python-worker/worker.py"], {
          TRACEFORGE_URL: BASE, TRACEFORGE_TOKEN: token, WORKER_NAME: "py-live", PYTHONPATH: process.env.E2E_DENTAL_AGENT_PATH,
          WORKER_MODELS_FILE: modelsFile, WORKER_OPENAI_BASE_URL: baseUrl,
        }, "python-live-worker");
        const registered = await waitFor(async () => /advertising \[[^\]]*agent\.run/.test(live.out), { timeoutMs: 90_000 });
        check("the live worker registers a test model and advertises agent.run", Boolean(registered), live.out.slice(-800));

        const mr = await dp.query("SELECT id FROM model_registry WHERE org_id = $1 AND name = 'live-test' AND stage = 'test'", [orgId]);
        const modelId = mr.rows[0]?.id;
        check("the test model is in the app's registry with stage `test`", Boolean(modelId), JSON.stringify(mr.rows));
        if (modelId) {
          const liveJob = await enqueue("agent.run", { imageId, modelId, mode: "with_tools", maxTurns: 12, maxToolCalls: 4, temperature: 0 });
          const done = await finish(liveJob, 240_000);
          check("agent.run on the test backend succeeds", done?.status === "succeeded", JSON.stringify(done?.error ?? done?.result).slice(0, 600));
          const traceId = done?.result?.traceId;
          check("  …and names the trace it stored", typeof traceId === "string", JSON.stringify(done?.result));
          if (traceId) {
            const tr = await dp.query("SELECT backend, stage, n_turns, n_tool_calls FROM traces WHERE id = $1", [traceId]);
            check("the stored trace carries backend/stage", tr.rows[0]?.backend === "openai_compat" && tr.rows[0]?.stage === "test", JSON.stringify(tr.rows[0]));
            const arts = await dp.query(
              "SELECT count(*)::int AS n FROM tool_calls c JOIN trace_turns t ON c.turn_id = t.id WHERE t.trace_id = $1 AND c.artifact_id IS NOT NULL",
              [traceId],
            );
            const liveCalls = await dp.query(
              "SELECT c.tool_name, c.artifact_id FROM tool_calls c JOIN trace_turns t ON c.turn_id = t.id WHERE t.trace_id = $1 ORDER BY t.idx, c.idx",
              [traceId],
            );
            const pageRes = await api(`/traces/${traceId}`);
            const html = await pageRes.text();
            if (liveCalls.rows.length > 0) {
              check("  …and at least one tool image is stored as an artifact", arts.rows[0].n > 0, JSON.stringify({ n: arts.rows[0].n, calls: liveCalls.rows }));
              check("  …and Trace Explorer opens it with the stored tool image", /stored artifact/.test(html) && /Test backend/.test(html), JSON.stringify({
                status: pageRes.status,
                notFound: /Trace not found/.test(html),
                heading: (html.match(/Trace [0-9a-f]{8}/) ?? [null])[0],
                testBackend: /Test backend/.test(html),
                artifactFigure: (html.match(/data-tool-image="artifact"/g) ?? []).length,
                placeholders: (html.match(/data-tool-image="placeholder"/g) ?? []).length,
                htmlLength: html.length,
              }));
            } else {
              // Not a silent pass: a model that answers in one turn never exercises the artifact path,
              // so this says so out loud. The stored-artifact rendering itself is covered by the
              // deterministic suite; the live check only claims what actually happened.
              console.log("  note the test model answered WITHOUT tool calls: no artifact could be stored");
              check("  …and Trace Explorer opens it (marked as the test backend)", /Test backend/.test(html));
            }
          }
        }
      } finally {
        if (live) await stop(live);
        await dp.end();
      }
    }
  } else {
    console.log("  note live agent.run checks NOT run (set E2E_LIVE_AGENT=1, E2E_DENTAL_AGENT_PATH and load a model in LM Studio)");
  }

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
    const traceId = t1.json.results[0].traceId;
    const counts = await tp.query(
      `SELECT (SELECT count(*)::int FROM traces WHERE org_id = $1 AND id = $2) AS traces,
              (SELECT count(*)::int FROM trace_turns WHERE org_id = $1 AND trace_id = $2) AS turns,
              (SELECT count(*)::int FROM tool_calls c JOIN trace_turns t ON c.turn_id = t.id
                WHERE c.org_id = $1 AND t.trace_id = $2) AS calls`,
      [orgId, traceId],
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

  // ---- realtime bus: wake-ups must beat the 5 s safety poll by a wide margin (only possible if the bus works) ----
  if (!REDIS) {
    console.log("  note realtime bus checks NOT run (set E2E_REDIS_URL to run them)");
  } else {
    const reg = await wpost("/register", { name: "e2e-rt", runtime: "local-gpu", capabilities: [{ job: "system.ping" }] });
    const rtWorker = reg.json.workerId;
    const claimBody = (waitMs) => ({ workerId: rtWorker, accepts: ["system.ping"], max: 1, waitMs });
    const enqueue = async () => (await (await api("/api/jobs", { method: "POST", body: { type: "system.ping", payload: {} } })).json()).id;

    // 1. an open SSE stream sees a claim almost immediately
    const watched = await enqueue();
    const res = await fetch(`${BASE}/api/jobs/${watched}/events`, { headers: { cookie, accept: "text/event-stream" }, signal: AbortSignal.timeout(20_000) });
    const rd = res.body.getReader();
    const dec = new TextDecoder();
    let raw = "";
    const readUntil = async (needle, ms) => {
      const end = Date.now() + ms;
      while (!raw.includes(needle) && Date.now() < end) {
        const r = await Promise.race([rd.read(), sleep(Math.max(1, end - Date.now())).then(() => null)]);
        if (r === null) break;
        if (r.done) break;
        raw += dec.decode(r.value);
      }
      return raw.includes(needle);
    };
    await readUntil('"status":"queued"', 5000);
    await sleep(300); // let the stream settle into its wait
    const tClaim = Date.now();
    const claimed = await wpost("/jobs/claim", claimBody(0));
    const sawClaim = await readUntil('"status":"claimed"', 4000);
    const sseMs = Date.now() - tClaim;
    check(
      `an open SSE stream shows a claim in ${sseMs} ms (< 1500; without the bus it would wait up to the 5000 ms safety poll)`,
      sawClaim && claimed.json.jobs.length === 1 && sseMs < 1500,
      JSON.stringify({ sawClaim, sseMs, claimed: claimed.json }),
    );
    await rd.cancel().catch(() => {});

    // 2. a parked worker long-poll is woken by a newly queued job
    const parked = wpost("/jobs/claim", claimBody(15_000));
    await sleep(400);
    const tEnqueue = Date.now();
    const queuedId = await enqueue();
    const got = await Promise.race([parked, sleep(6000).then(() => null)]);
    const pollMs = Date.now() - tEnqueue;
    check(
      `a parked worker long-poll returns the new job in ${pollMs} ms (< 1500)`,
      got !== null && got.json.jobs.some((j) => j.id === queuedId) && pollMs < 1500,
      JSON.stringify({ pollMs, got: got && got.json }),
    );
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
