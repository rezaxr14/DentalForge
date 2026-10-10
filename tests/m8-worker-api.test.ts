/**
 * M8 HTTP contract (plan §10): the whole worker lifecycle through real
 * Request/Response objects — no Next runtime needed because every route is a
 * one-line wrapper over a framework-free handler. Runs on BOTH stores.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import { MemoryStore } from "@/shared/db/memory";
import { DrizzleOrgStore } from "@/shared/db/repositories";
import type { OrgRecord, OrgStore } from "@/shared/db/repos";
import { getEnv } from "@/shared/config/env";
import { getPgDb } from "@/shared/db/pg";
import { organizations } from "@/shared/db/schema";
import { LocalStorageAdapter, sha256Hex } from "@/shared/storage/adapter";
import { getObject, putObject } from "@/shared/storage/gateway";
import { mintWorkerToken } from "@/shared/jobs/tokens";
import * as W from "@/shared/jobs/worker-handlers";
import * as U from "@/shared/jobs/user-handlers";
import type { Actor } from "@/shared/jobs/user-handlers";

const probe = new pg.Pool({ connectionString: getEnv().DATABASE_URL, connectionTimeoutMillis: 1500 });
let dbUp = false;
try {
  await probe.query("SELECT 1");
  dbUp = true;
} catch {
  dbUp = false;
}
await probe.end();
if (!dbUp && process.env.CI) throw new Error("[m8-worker-api] CI requires Postgres.");

const BASE = "http://test.local";
const SECRET = "test-secret-test-secret-test-secret-0123";
const suffix = Date.now().toString(36);

const backends = [
  { name: "memory", skip: false, make: (): OrgStore => new MemoryStore() },
  { name: "drizzle (postgres)", skip: !dbUp, make: (): OrgStore => new DrizzleOrgStore(getPgDb()) },
];

function wreq(
  path: string,
  o: { method?: string; token?: string | null; workerId?: string | null; body?: unknown; version?: string | null } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.version !== null) headers["x-contract-version"] = o.version ?? "1";
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.workerId) headers["x-worker-id"] = o.workerId;
  return new Request(`${BASE}/api/worker/v1${path}`, {
    method: o.method ?? "POST",
    headers,
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
}

function ureq(path: string, o: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Request {
  return new Request(`${BASE}/api/jobs${path}`, {
    method: o.method ?? "POST",
    headers: { "content-type": "application/json", ...(o.headers ?? {}) },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
}

describe.each(backends)("worker API contract — $name", ({ skip, make }) => {
  const d = skip ? describe.skip : describe;
  d("lifecycle", () => {
    let store: OrgStore;
    let org: OrgRecord;
    let other: OrgRecord;
    let token: string;
    let readToken: string;
    let admin: Actor;
    let annotator: Actor;
    let outsider: Actor;
    let storage: LocalStorageAdapter;
    const noSleep = async () => {};

    const deps = () => ({ store, storage, sleep: noSleep });
    const udeps = (actor: Actor | null, workerMode: "off" | "mock" | "live" = "live") => ({ store, actor, workerMode });

    async function registerWorker(name = "w1", caps = ["system.ping", "tool.execute"]) {
      const res = await W.register(
        wreq("/register", {
          token,
          body: { name, runtime: "local-gpu", capabilities: caps.map((job) => ({ job })) },
        }),
        deps(),
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { workerId: string }).workerId;
    }

    async function enqueue(type = "system.ping", payload: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
      const res = await U.createJob(ureq("", { body: { type, payload }, headers }), udeps(admin));
      expect(res.status).toBe(201);
      return (await res.json()) as { id: string; status: string; payload: Record<string, unknown> };
    }

    async function claim(workerId: string, accepts = ["system.ping", "tool.execute"]) {
      const res = await W.claim(wreq("/jobs/claim", { token, body: { workerId, accepts, max: 1, waitMs: 0 } }), deps());
      expect(res.status).toBe(200);
      return ((await res.json()) as { jobs: { id: string; attempt: number; payload: Record<string, unknown> }[] }).jobs;
    }

    beforeAll(async () => {
      store = make();
      const s = `${suffix}-${Math.random().toString(36).slice(2, 6)}`;
      org = await store.createOrg({ slug: `m8w-a-${s}`, name: "A" });
      other = await store.createOrg({ slug: `m8w-b-${s}`, name: "B" });
      const minted = mintWorkerToken();
      token = minted.token;
      await store.scoped(org.id).createWorkerToken({ name: "t", tokenHash: minted.tokenHash, scopes: "jobs:write" });
      const ro = mintWorkerToken();
      readToken = ro.token;
      await store.scoped(org.id).createWorkerToken({ name: "ro", tokenHash: ro.tokenHash, scopes: "jobs:read" });
      admin = { userId: "u-admin", orgId: org.id, role: "admin" };
      annotator = { userId: "u-ann", orgId: org.id, role: "annotator" };
      outsider = { userId: "u-out", orgId: other.id, role: "admin" };
      storage = new LocalStorageAdapter(mkdtempSync(join(tmpdir(), "tf-m8-")), { secret: SECRET });
    });

    afterAll(async () => {
      if (store instanceof DrizzleOrgStore) {
        await getPgDb().delete(organizations).where(inArray(organizations.id, [org.id, other.id]));
      }
    });

    // ------------------------------------------------------------------ auth
    it("rejects bad contract headers and tokens with problem+json", async () => {
      const noVersion = await W.register(wreq("/register", { token, version: null, body: {} }), deps());
      expect(noVersion.status).toBe(400);
      expect(noVersion.headers.get("content-type")).toContain("application/problem+json");

      const v2 = await W.register(wreq("/register", { token, version: "2", body: {} }), deps());
      expect(v2.status).toBe(426);
      expect(((await v2.json()) as { supported: number[] }).supported).toEqual([1]);

      const noTok = await W.register(wreq("/register", { body: {} }), deps());
      expect(noTok.status).toBe(401);
      expect(noTok.headers.get("www-authenticate")).toContain("Bearer");

      const bad = await W.register(wreq("/register", { token: "tf_wrk_nope", body: {} }), deps());
      expect(bad.status).toBe(401);
      expect(((await bad.json()) as { code: string }).code).toBe("unauthorized");

      const ro = await W.register(wreq("/register", { token: readToken, body: { name: "x", runtime: "colab" } }), deps());
      expect(ro.status).toBe(403); // jobs:read cannot register
    });

    it("a revoked token stops working immediately", async () => {
      const m = mintWorkerToken();
      const t = await store.scoped(org.id).createWorkerToken({ name: "tmp", tokenHash: m.tokenHash, scopes: "jobs:write" });
      const ok = await W.register(wreq("/register", { token: m.token, body: { name: "tmp-w", runtime: "colab" } }), deps());
      expect(ok.status).toBe(200);
      await store.scoped(org.id).revokeWorkerToken(t.id);
      const after = await W.register(wreq("/register", { token: m.token, body: { name: "tmp-w", runtime: "colab" } }), deps());
      expect(after.status).toBe(401);
    });

    // -------------------------------------------------------------- register
    it("register is an upsert by name and validates input", async () => {
      const a = await registerWorker("upsert-w");
      const b = await registerWorker("upsert-w", ["yolo.prelabel"]);
      expect(b).toBe(a);
      const w = await store.scoped(org.id).getWorker(a);
      expect(w!.capabilities).toEqual(["yolo.prelabel"]);

      const bad = await W.register(wreq("/register", { token, body: { name: "x", runtime: "tpu-farm" } }), deps());
      expect(bad.status).toBe(422);
    });

    it("heartbeat: unknown worker is 403; known worker gets an empty cancel list", async () => {
      const unknown = await W.heartbeat(wreq("/heartbeat", { token, body: { workerId: "00000000-0000-4000-8000-000000000000" } }), deps());
      expect(unknown.status).toBe(403);
      const id = await registerWorker("hb-w");
      const ok = await W.heartbeat(wreq("/heartbeat", { token, body: { workerId: id, status: "idle" } }), deps());
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ cancelJobIds: [] });
    });

    // ------------------------------------------------------------- lifecycle
    it("end to end: enqueue → claim → events → artifact upload → complete → replay", async () => {
      const wid = await registerWorker("e2e-w");
      const job = await enqueue("system.ping", { message: "hello" });
      expect(job.payload).toMatchObject({ message: "hello", steps: 3 }); // schema defaults applied at enqueue

      const [claimed] = await claim(wid);
      expect(claimed!.id).toBe(job.id);
      expect(claimed!.attempt).toBe(1);

      const ev = await W.postEvents(
        wreq(`/jobs/${job.id}/events`, {
          token,
          workerId: wid,
          body: { events: [{ seq: 1, type: "progress", data: { pct: 50 } }, { seq: 2, type: "log", data: { line: "hi" } }] },
        }),
        deps(),
        job.id,
      );
      expect(ev.status).toBe(200);
      expect(((await ev.json()) as { accepted: number }).accepted).toBe(2);

      const resend = await W.postEvents(
        wreq(`/jobs/${job.id}/events`, { token, workerId: wid, body: { events: [{ seq: 2, type: "log", data: {} }] } }),
        deps(),
        job.id,
      );
      expect(((await resend.json()) as { accepted: number }).accepted).toBe(0); // idempotent

      expect(((await (await U.getJob(ureq("", { method: "GET" }), udeps(admin), job.id)).json()) as { status: string }).status).toBe("running");

      // Artifact upload through a signed URL.
      const bytes = Buffer.from("not-really-a-png");
      const presign = await W.presignArtifact(
        wreq(`/jobs/${job.id}/artifacts/presign`, {
          token,
          workerId: wid,
          body: { name: "out.png", mime: "image/png", bytes: bytes.length, sha256: sha256Hex(bytes) },
        }),
        deps(),
        job.id,
      );
      expect(presign.status).toBe(200);
      const p = (await presign.json()) as { artifactId: string; uploadUrl: string };
      expect(p.uploadUrl.startsWith("http://test.local/api/storage/")).toBe(true);
      expect(p.uploadUrl).toContain(org.id); // tenant-scoped key
      const key = decodeURIComponent(new URL(p.uploadUrl).pathname.replace("/api/storage/", ""));
      const put = await putObject(new Request(p.uploadUrl, { method: "PUT", body: bytes }), key, storage, SECRET);
      expect(put.status).toBe(200);

      const done = await W.complete(
        wreq(`/jobs/${job.id}/complete`, {
          token,
          workerId: wid,
          body: { result: { echo: "hello", workerName: "e2e-w", steps: 3 }, artifactIds: [p.artifactId] },
        }),
        deps(),
        job.id,
      );
      expect(done.status).toBe(200);
      const replay = await W.complete(
        wreq(`/jobs/${job.id}/complete`, {
          token,
          workerId: wid,
          body: { result: { echo: "hello", workerName: "e2e-w", steps: 3 }, artifactIds: [p.artifactId] },
        }),
        deps(),
        job.id,
      );
      expect(replay.status).toBe(200); // lost-response retry is safe

      const final = (await (await U.getJob(ureq("", { method: "GET" }), udeps(admin), job.id)).json()) as {
        status: string;
        result: unknown;
        artifactIds: string[];
      };
      expect(final.status).toBe("succeeded");
      expect(final.result).toEqual({ echo: "hello", workerName: "e2e-w", steps: 3 });
      expect(final.artifactIds).toEqual([p.artifactId]);

      const page = (await (await U.jobEvents(ureq(`/${job.id}/events?format=json`, { method: "GET" }), udeps(admin), job.id)).json()) as {
        events: { seq: number }[];
        done: boolean;
        nextAfter: number;
      };
      expect(page.events.map((e) => e.seq)).toEqual([1, 2]);
      expect(page.done).toBe(true);
      expect(page.nextAfter).toBe(2);
    });

    it("rejects an invalid result (422, job keeps running) and foreign artifact ids", async () => {
      const wid = await registerWorker("val-w");
      const job = await enqueue("system.ping");
      await claim(wid);
      const bad = await W.complete(
        wreq(`/jobs/${job.id}/complete`, { token, workerId: wid, body: { result: { nope: true }, artifactIds: [] } }),
        deps(),
        job.id,
      );
      expect(bad.status).toBe(422);
      expect(((await bad.json()) as { code: string }).code).toBe("validation_failed");
      expect((await store.scoped(org.id).getJob(job.id))!.status).toBe("claimed");

      const foreign = await store.scoped(other.id).createArtifact({
        kind: "report", storageKey: `x/${suffix}`, mime: null, width: null, height: null, bytes: null, sha256: null, provenance: "worker_exact",
      });
      const smuggle = await W.complete(
        wreq(`/jobs/${job.id}/complete`, {
          token,
          workerId: wid,
          body: { result: { echo: "e", workerName: "val-w", steps: 0 }, artifactIds: [foreign.id] },
        }),
        deps(),
        job.id,
      );
      expect(smuggle.status).toBe(422);
      expect((await store.scoped(org.id).getJob(job.id))!.status).not.toBe("succeeded");
    });

    it("result ids must be echoed exactly as given: an integer id passes, its stringified form does not", async () => {
      const wid = await registerWorker("ids-w", ["al.score"]);
      const job = await enqueue("al.score", { imageIds: [1, 2], modelId: "m" });
      await claim(wid, ["al.score"]);
      const score = (imageId: unknown) => ({ imageId, meanConf: 0.5, minConf: 0.1, entropy: 0.7, nBoxes: 3 });

      const stringified = await W.complete(
        wreq(`/jobs/${job.id}/complete`, { token, workerId: wid, body: { result: { scores: [score("1"), score("2")] } } }),
        deps(),
        job.id,
      );
      expect(stringified.status).toBe(422); // "1" is neither a uuid nor an integer
      expect((await store.scoped(org.id).getJob(job.id))!.status).toBe("claimed"); // worker may correct and retry

      const ok = await W.complete(
        wreq(`/jobs/${job.id}/complete`, { token, workerId: wid, body: { result: { scores: [score(1), score(2)] } } }),
        deps(),
        job.id,
      );
      expect(ok.status).toBe(200);
    });

    it("the lease fence: a different worker, a missing header and an unknown worker are all refused", async () => {
      const wid = await registerWorker("fence-a");
      const intruder = await registerWorker("fence-b");
      const job = await enqueue("system.ping");
      await claim(wid);
      const ev = { events: [{ seq: 1, type: "log", data: {} }] };

      const wrong = await W.postEvents(wreq(`/jobs/${job.id}/events`, { token, workerId: intruder, body: ev }), deps(), job.id);
      expect(wrong.status).toBe(409);
      expect(((await wrong.json()) as { code: string }).code).toBe("job_not_owner");

      const noHeader = await W.postEvents(wreq(`/jobs/${job.id}/events`, { token, body: ev }), deps(), job.id);
      expect(noHeader.status).toBe(400);

      const ghost = await W.postEvents(
        wreq(`/jobs/${job.id}/events`, { token, workerId: "00000000-0000-4000-8000-000000000000", body: ev }),
        deps(),
        job.id,
      );
      expect(ghost.status).toBe(403);

      const completeWrong = await W.complete(
        wreq(`/jobs/${job.id}/complete`, { token, workerId: intruder, body: { result: { echo: "", workerName: "", steps: 0 } } }),
        deps(),
        job.id,
      );
      expect(completeWrong.status).toBe(409);
    });

    it("cancel: the holder sees it via heartbeat and its writes are refused with job_cancelled", async () => {
      const wid = await registerWorker("cancel-w");
      const job = await enqueue("system.ping");
      await claim(wid);
      const cancel = await U.cancelJob(ureq(`/${job.id}/cancel`), udeps(admin), job.id);
      expect(((await cancel.json()) as { status: string }).status).toBe("cancelled");

      const hb = await W.heartbeat(wreq("/heartbeat", { token, body: { workerId: wid } }), deps());
      expect(((await hb.json()) as { cancelJobIds: string[] }).cancelJobIds).toContain(job.id);

      const ev = await W.postEvents(
        wreq(`/jobs/${job.id}/events`, { token, workerId: wid, body: { events: [{ seq: 1, type: "log", data: {} }] } }),
        deps(),
        job.id,
      );
      expect(ev.status).toBe(409);
      expect(((await ev.json()) as { code: string }).code).toBe("job_cancelled");
    });

    it("a heartbeat renews the lease, so a long job with no events is not reaped from a live worker", async () => {
      const wid = await registerWorker("renew-w");
      const job = await enqueue("system.ping");
      // Claim with an already-expired lease (what a long quiet job looks like after 60 s).
      await store.scoped(org.id).claimJobs(wid, ["system.ping"], 1, 0);
      await new Promise((r) => setTimeout(r, 5));
      const hb = await W.heartbeat(wreq("/heartbeat", { token, body: { workerId: wid } }), deps());
      expect(hb.status).toBe(200);
      const after = (await store.scoped(org.id).getJob(job.id))!;
      expect(after.status).toBe("claimed"); // renewed, then the reap found nothing to do
      expect(after.claimedBy).toBe(wid);
      expect(after.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 30_000);
    });

    it("fail: a retryable failure requeues and the next claim is attempt 2", async () => {
      const wid = await registerWorker("fail-w");
      const job = await enqueue("system.ping");
      await claim(wid);
      const f = await W.fail(
        wreq(`/jobs/${job.id}/fail`, { token, workerId: wid, body: { error: { code: "oom", message: "cuda oom", retryable: true } } }),
        deps(),
        job.id,
      );
      expect(await f.json()).toEqual({ ok: true, attemptsRemaining: 2 });
      const [again] = await claim(wid);
      expect(again!.id).toBe(job.id);
      expect(again!.attempt).toBe(2);
    });

    it("long-poll claim waits, then returns a job enqueued while it waited", async () => {
      const wid = await registerWorker("poll-w");
      let sleeps = 0;
      let clock = 1_000_000;
      const res = await W.claim(
        wreq("/jobs/claim", { token, body: { workerId: wid, accepts: ["system.ping"], max: 1, waitMs: 5000 } }),
        {
          store,
          storage,
          now: () => clock,
          sleep: async (ms: number) => {
            sleeps += 1;
            clock += ms;
            if (sleeps === 2) await enqueue("system.ping", { message: "late" });
          },
        },
      );
      const body = (await res.json()) as { jobs: { payload: { message: string } }[] };
      expect(body.jobs).toHaveLength(1);
      expect(body.jobs[0]!.payload.message).toBe("late");
      expect(sleeps).toBe(2);

      // And it gives up at the deadline with an empty list, not an error.
      let t = 5_000_000;
      const empty = await W.claim(
        wreq("/jobs/claim", { token, body: { workerId: wid, accepts: ["nothing.here"], max: 1, waitMs: 2000 } }),
        { store, storage, now: () => t, sleep: async (ms: number) => { t += ms; } },
      );
      expect(await empty.json()).toEqual({ jobs: [] });
    });

    it("claim refuses a worker id from another org", async () => {
      const m = mintWorkerToken();
      await store.scoped(other.id).createWorkerToken({ name: "o", tokenHash: m.tokenHash, scopes: "jobs:write" });
      const foreign = await store.scoped(other.id).registerWorker({ name: "foreign", runtime: "colab" });
      const res = await W.claim(wreq("/jobs/claim", { token, body: { workerId: foreign.id, accepts: ["system.ping"], max: 1, waitMs: 0 } }), deps());
      expect(res.status).toBe(403);
    });

    it("documented-but-deferred endpoints answer 501 problem+json", async () => {
      const res = W.notImplemented("POST /api/worker/v1/ingest/traces");
      expect(res.status).toBe(501);
      expect(((await res.json()) as { code: string }).code).toBe("not_implemented");
    });

    it("image URL: 404 for unknown/foreign images and non-original variants", async () => {
      const none = await W.imageUrl(wreq("/images/00000000-0000-4000-8000-000000000000", { method: "GET", token: readToken }), deps(), "00000000-0000-4000-8000-000000000000");
      expect(none.status).toBe(404);
      const variant = await W.imageUrl(wreq("/images/00000000-0000-4000-8000-000000000000?variant=thumb_320", { method: "GET", token: readToken }), deps(), "00000000-0000-4000-8000-000000000000");
      expect(variant.status).toBe(404);
      const junk = await W.imageUrl(wreq("/images/not-a-uuid", { method: "GET", token: readToken }), deps(), "not-a-uuid");
      expect(junk.status).toBe(404);
    });

    // ------------------------------------------------------- user-facing API
    it("user endpoints: auth, roles, validation, idempotency, integration-off and tenant isolation", async () => {
      expect((await U.createJob(ureq("", { body: { type: "system.ping" } }), udeps(null))).status).toBe(401);

      const asAnnotator = await U.createJob(ureq("", { body: { type: "system.ping" } }), udeps(annotator));
      expect(asAnnotator.status).toBe(201); // annotators may enqueue

      const cancelByAnnotator = await U.cancelJob(ureq("/x/cancel"), udeps(annotator), "00000000-0000-4000-8000-000000000000");
      expect(cancelByAnnotator.status).toBe(403); // but not cancel

      const off = await U.createJob(ureq("", { body: { type: "system.ping" } }), udeps(admin, "off"));
      expect(off.status).toBe(503);
      expect(((await off.json()) as { code: string }).code).toBe("worker_integration_off");

      expect((await U.createJob(ureq("", { body: { type: "no.such.type" } }), udeps(admin))).status).toBe(422);
      expect((await U.createJob(ureq("", { body: { type: "system.ping", payload: { steps: 999 } } }), udeps(admin))).status).toBe(422);
      expect((await U.createJob(new Request(`${BASE}/api/jobs`, { method: "POST", body: "{not json" }), udeps(admin))).status).toBe(400);

      const key = `idem-${suffix}`;
      const j1 = (await (await U.createJob(ureq("", { body: { type: "system.ping" }, headers: { "idempotency-key": key } }), udeps(admin))).json()) as { id: string };
      const j2 = (await (await U.createJob(ureq("", { body: { type: "system.ping" }, headers: { "idempotency-key": key } }), udeps(admin))).json()) as { id: string };
      expect(j2.id).toBe(j1.id);

      // Tenant isolation at the HTTP layer.
      expect((await U.getJob(ureq("", { method: "GET" }), udeps(outsider), j1.id)).status).toBe(404);
      expect((await U.cancelJob(ureq(`/${j1.id}/cancel`), udeps(outsider), j1.id)).status).toBe(404);
      expect((await U.jobEvents(ureq(`/${j1.id}/events?format=json`, { method: "GET" }), udeps(outsider), j1.id)).status).toBe(404);
      const listed = (await (await U.listJobs(ureq("?limit=100", { method: "GET" }), udeps(outsider))).json()) as { jobs: { id: string }[] };
      expect(listed.jobs.find((j) => j.id === j1.id)).toBeUndefined();

      expect((await U.getJob(ureq("", { method: "GET" }), udeps(admin), "not-a-uuid")).status).toBe(404);
      expect((await U.listJobs(ureq("?status=bogus", { method: "GET" }), udeps(admin))).status).toBe(400);
    });
  });
});

// ---------------------------------------------------------------------------
describe("SSE job event stream (framework-free)", () => {
  async function readAll(res: Response): Promise<string> {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return out;
      out += dec.decode(value);
    }
  }
  const frames = (raw: string) =>
    raw
      .split("\n\n")
      .filter((f) => f.trim().length > 0)
      .map((f) => {
        const o: Record<string, string> = {};
        for (const line of f.split("\n")) {
          const i = line.indexOf(":");
          if (i > 0) o[line.slice(0, i)] = line.slice(i + 1).trim();
        }
        return o;
      });

  async function setup() {
    const store = new MemoryStore();
    const org = await store.createOrg({ slug: "sse", name: "sse" });
    const repos = store.scoped(org.id);
    const actor: Actor = { userId: "u", orgId: org.id, role: "admin" };
    const job = await repos.createJob({ type: "system.ping", payload: {} });
    return { store, org, repos, actor, job };
  }

  it("streams status + events in order, resumes by Last-Event-ID, and ends when terminal", async () => {
    const { store, repos, actor, job } = await setup();
    let step = 0;
    const sleep = async () => {
      step += 1;
      if (step === 1) {
        await repos.claimJobs("w", ["system.ping"], 1, 60);
        await repos.appendJobEvents(job.id, "w", [{ seq: 1, type: "progress", data: { pct: 10 } }, { seq: 2, type: "turn", data: { turn: 1 } }], 60);
      } else if (step === 2) {
        await repos.appendJobEvents(job.id, "w", [{ seq: 3, type: "partial", data: {} }], 60);
        await repos.completeJob(job.id, "w", { echo: "x", workerName: "w", steps: 0 }, []);
      }
    };
    const res = await U.jobEvents(
      new Request(`${BASE}/api/jobs/${job.id}/events`, { headers: { accept: "text/event-stream" } }),
      { store, actor, workerMode: "live", sse: { sleep, pollMs: 1 } },
      job.id,
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const f = frames(await readAll(res));
    expect(f[0]).toMatchObject({ retry: "2000" });
    const seq = f.map((x) => x.event ?? (x.retry ? "retry" : "other"));
    // queued → (claim + first events land in one poll tick) running → succeeded
    expect(seq).toEqual(["retry", "status", "progress", "turn", "status", "partial", "status", "end"]);
    expect(f.filter((x) => x.id).map((x) => x.id)).toEqual(["1", "2", "3"]); // ids are seqs
    expect(f.at(-1)!.data).toContain("succeeded");

    // Resume: a reconnect with Last-Event-ID: 2 replays only seq 3 (+ status + end).
    const resumed = await U.jobEvents(
      new Request(`${BASE}/api/jobs/${job.id}/events`, { headers: { "last-event-id": "2" } }),
      { store, actor, workerMode: "live", sse: { sleep: async () => {}, pollMs: 1 } },
      job.id,
    );
    const rf = frames(await readAll(resumed));
    expect(rf.filter((x) => x.id).map((x) => x.id)).toEqual(["3"]);
    expect(rf.at(-1)!.event).toBe("end");
  });

  it("closes itself with a reconnect hint before the platform limit", async () => {
    const { store, actor, job } = await setup();
    let t = 0;
    const res = await U.jobEvents(
      new Request(`${BASE}/api/jobs/${job.id}/events`),
      { store, actor, workerMode: "live", sse: { now: () => t, sleep: async (ms: number) => { t += ms; }, pollMs: 10_000, maxMs: 25_000, keepaliveMs: 15_000 } },
      job.id,
    );
    const raw = await readAll(res);
    expect(raw).toContain(": keepalive"); // quiet streams stay alive through proxies
    const f = frames(raw);
    expect(f.at(-1)!.event).toBe("reconnect");
  });

  it("404s an unknown job instead of opening a stream", async () => {
    const { store, actor } = await setup();
    const res = await U.jobEvents(new Request(`${BASE}/api/jobs/x/events`), { store, actor, workerMode: "live" }, "00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe("storage gateway (signed URLs)", () => {
  const dir = mkdtempSync(join(tmpdir(), "tf-gw-"));
  const t = 2_000_000_000;
  const storage = new LocalStorageAdapter(dir, { secret: SECRET, now: () => t });
  const data = Buffer.from("hello gateway");
  const sha = sha256Hex(data);

  async function upload() {
    const up = await storage.presignUpload({ name: "a.png", mime: "image/png", bytes: data.length, sha256: sha, prefix: "org1" });
    return { up, url: `${BASE}${up.uploadUrl}` };
  }

  it("accepts a signed PUT, then serves a signed GET with hardening headers", async () => {
    const { up, url } = await upload();
    const put = await putObject(new Request(url, { method: "PUT", body: data }), up.key, storage, SECRET, t);
    expect(put.status).toBe(200);
    const dl = await storage.presignDownload(up.key, 60);
    const got = await getObject(new Request(`${BASE}${dl}`), up.key, storage, SECRET, t);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await got.arrayBuffer()).toString()).toBe("hello gateway");
  });

  it("refuses wrong bytes, wrong hash, tampering, expiry, wrong operation and unsigned access", async () => {
    const { up, url } = await upload();
    expect((await putObject(new Request(url, { method: "PUT", body: Buffer.from("short") }), up.key, storage, SECRET, t)).status).toBe(422);
    expect((await putObject(new Request(url, { method: "PUT", body: Buffer.from("hello gateXXX") }), up.key, storage, SECRET, t)).status).toBe(422); // same size, different bytes
    expect((await putObject(new Request(url.replace("bytes=13", "bytes=14"), { method: "PUT", body: data }), up.key, storage, SECRET, t)).status).toBe(403);
    expect((await putObject(new Request(url, { method: "PUT", body: data }), up.key, storage, SECRET, t + 16 * 60)).status).toBe(403); // expired (15 min TTL)
    expect((await putObject(new Request(url, { method: "PUT", body: data }), "org1/other-key.png", storage, SECRET, t)).status).toBe(403); // key bound
    expect((await putObject(new Request(url, { method: "PUT", body: data }), up.key, storage, "a-different-secret-a-different-secret", t)).status).toBe(403);
    expect((await getObject(new Request(url), up.key, storage, SECRET, t)).status).toBe(403); // put-URL cannot read
    expect((await getObject(new Request(`${BASE}/api/storage/${up.key}`), up.key, storage, SECRET, t)).status).toBe(403); // unsigned
  });

  it("never lets a traversal key reach the filesystem", async () => {
    const { url } = await upload();
    const res = await putObject(new Request(url, { method: "PUT", body: data }), "../../etc/passwd", storage, SECRET, t);
    expect(res.status).toBe(400);
  });
});
