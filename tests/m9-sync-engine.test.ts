/**
 * The sync engine (ADR-0020) against the REAL label handlers, versioning, validation and state machine, on both stores.
 * The editor is stood in for by the real history core; time is advanced by hand.
 */
import pg from "pg";
import { describe, expect, it } from "vitest";
import { getEnv } from "@/shared/config/env";
import { getPgDb } from "@/shared/db/pg";
import { MemoryStore } from "@/shared/db/memory";
import { DrizzleOrgStore } from "@/shared/db/repositories";
import type { OrgStore } from "@/shared/db/repos";
import type { Role } from "@/shared/domain/auth";
import { history as H } from "@/shared/domain/editing";
import type { Actor } from "@/shared/jobs/user-handlers";
import { createLabelClient } from "@/shared/labels/client";
import * as h from "@/shared/labels/handlers";
import { backoffMs, createSyncEngine, type RemoteReason, type SyncView } from "@/shared/labels/sync-engine";
import { box } from "./helpers/annotation-repo-suite";
import { labelFetch, manualScheduler, newWorld } from "./helpers/label-server";

const pool = new pg.Pool({ connectionString: getEnv().DATABASE_URL });
let dbUp = false;
try {
  await pool.query("SELECT 1");
  dbUp = true;
} catch {
  dbUp = false;
}
await pool.end();
if (!dbUp && process.env.CI) throw new Error("[m9-sync-engine] CI requires Postgres: the SQL half of this suite must run, not skip.");

let n = 0;
const unique = Date.now().toString(36);
const problem = (status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ code: "x", title: "T", detail: "d", ...extra }), { status, headers: { "content-type": "application/problem+json", ...headers } });

function define(label: string, makeStore: () => Promise<OrgStore>, skip = false): void {
  describe.skipIf(skip)(`sync engine: ${label}`, () => {
    async function world() {
      const store = await makeStore();
      const orgId = (await store.createOrg({ slug: `se-${unique}-${++n}`, name: "o" })).id;
      const session = (userId: string, role: Role = "annotator") => {
        const cur: { actor: Actor | null } = { actor: { userId, orgId, role } };
        const w = newWorld(store, () => cur.actor);
        const sched = manualScheduler(() => w.log.length * 100_000 + w.inFlight.done, () => w.inFlight.now > 0 && !w.holding);
        let hist = H.createHistory([]);
        const remote: { why: RemoteReason; ids: string[] }[] = [];
        const views: SyncView[] = [];
        const engine = createSyncEngine({
          imageId: "1",
          client: createLabelClient(labelFetch(w)),
          getPresent: () => hist.present,
          onRemote: (a, why) => {
            hist = H.reset(hist, a);
            remote.push({ why, ids: a.map((x) => x.id) });
          },
          onView: (v) => views.push(v),
          scheduler: sched,
          now: sched.now,
        });
        return {
          engine, sched, w, cur, views, remote,
          get present() { return hist.present; },
          get view() { return engine.view(); },
          ops: () => w.log.filter((l) => l.action === "ops"),
          draw(id: string, bbox: [number, number, number, number] = [100, 100, 50, 60]) { hist = H.create(hist, box(id, { bbox, author_id: userId })); engine.notifyChange(); },
          drag(id: string, bbox: [number, number, number, number]) { hist = H.update(hist, id, { bbox }); engine.notifyChange(); },
          label(id: string, pathology: string) { hist = H.update(hist, id, { pathology }); engine.notifyChange(); },
          remove(id: string) { hist = H.remove(hist, id); engine.notifyChange(); },
        };
      };
      const read = async () => (await (await h.getSet({ store, actor: { userId: "reader", orgId, role: "annotator" } }, "1")).json()) as { version: number; state: string; annotations: { id: string; bbox: number[]; pathology: string; author_id: string }[] };
      return { store, orgId, session, read };
    }
    type Ed = ReturnType<Awaited<ReturnType<typeof world>>["session"]>;
    const ids = (e: Ed) => e.present.map((a) => a.id);

    it("starts in local mode when signed out, when the server says it is unavailable, on a failing status call, and on a 403 from open", async () => {
      const { session } = await world();
      const out = session("alice");
      out.cur.actor = null;
      await out.engine.start();
      expect(out.view).toMatchObject({ mode: "local", localReason: "signed-out" });
      expect(out.w.log.map((l) => l.action)).toEqual(["status"]); // one question that is always answered 200, then nothing
      const noDb = session("alice");
      noDb.w.intercept = () => new Response(JSON.stringify({ available: false, reason: "unavailable" }), { status: 200, headers: { "content-type": "application/json" } });
      await noDb.engine.start();
      expect(noDb.view).toMatchObject({ mode: "local", localReason: "server-unavailable" });
      expect(noDb.w.log.map((l) => l.action)).toEqual(["status"]);
      const down = session("alice");
      down.w.intercept = () => problem(503, {}, { "retry-after": "9" });
      await down.engine.start();
      expect(down.view).toMatchObject({ mode: "local", localReason: "server-unavailable" });
      const denied = session("alice");
      denied.w.intercept = ({ action }) => (action === "open" ? problem(403, { detail: "Your role cannot open images for labelling" }) : null);
      await denied.engine.start();
      expect(denied.view).toMatchObject({ mode: "local", localReason: "forbidden", message: "Your role cannot open images for labelling" });
    });

    it("asks status, then opens (idempotent): the first opener becomes the assignee, a later one just loads the set", async () => {
      const { session } = await world();
      const a = session("alice");
      await a.engine.start();
      expect(a.w.log.map((l) => l.action)).toEqual(["status", "open"]);
      expect(a.view).toMatchObject({ mode: "server", status: "saved", version: 1, state: "draft", viewer: { userId: "alice", role: "annotator" }, assigneeId: "alice" });
      expect(a.remote).toEqual([{ why: "load", ids: [] }]);
      const b = session("bob");
      await b.engine.start();
      expect(b.w.log.map((l) => l.action)).toEqual(["status", "open"]);
      expect(b.view.assigneeId).toBe("alice");
    });

    it("debounces a burst of edits into ONE request, saves them, and reports pending then saved", async () => {
      const { session, read } = await world();
      const a = session("alice");
      await a.engine.start();
      a.draw("a1");
      await a.sched.advance(700);
      a.draw("a2", [300, 100, 50, 60]);
      await a.sched.advance(700); // 1.4 s after the first edit: a debounce that is not restarted would have fired at 0.8 s
      a.label("a1", "Impacted");
      expect(a.view.status).toBe("pending");
      expect(a.ops()).toHaveLength(0);
      await a.sched.advance(800);
      expect(a.ops()).toHaveLength(1);
      expect(a.view).toMatchObject({ status: "saved", version: 2 });
      const s = await read();
      expect(s.annotations.map((x) => [x.id, x.pathology])).toEqual([["a1", "Impacted"], ["a2", "Caries"]]);
      expect(a.views.map((v) => v.status)).toEqual(expect.arrayContaining(["pending", "saving", "saved"]));
      expect(a.remote).toEqual([{ why: "load", ids: [] }]); // the engine never echoes the editor's own edits back
    });

    it("still saves while edits keep arriving faster than the debounce (max wait)", async () => {
      const { session } = await world();
      const a = session("alice");
      await a.engine.start();
      for (let i = 0; i < 8; i++) {
        a.draw(`b${i}`, [10 + i * 60, 10, 50, 50]);
        await a.sched.advance(500);
      }
      expect(a.ops().length).toBeGreaterThanOrEqual(1); // 4 s of continuous edits crossed the 3 s max wait
      await a.sched.advance(1000);
      expect(a.view.status).toBe("saved");
    });

    it("keeps exactly one request in flight and sends edits made meanwhile in the next round", async () => {
      const { session, read } = await world();
      const a = session("alice");
      await a.engine.start();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let first = true;
      a.w.intercept = async ({ action }) => {
        if (action === "ops" && first) {
          first = false;
          await gate;
        }
        return null;
      };
      a.w.holding = true;
      a.draw("b1");
      await a.sched.advance(800);
      a.draw("b2", [300, 100, 50, 60]);
      await a.sched.advance(800); // the debounce fires while request 1 is still out
      expect(a.ops()).toHaveLength(1);
      a.w.holding = false;
      release();
      await a.sched.advance(10);
      expect(a.ops()).toHaveLength(2);
      expect(a.w.inFlight.max).toBe(1);
      expect((await read()).annotations.map((x) => x.id)).toEqual(["b1", "b2"]);
      expect(a.view.status).toBe("saved");
    });

    it("sends more than 200 changes in chunks of 200", async () => {
      const { session, read } = await world();
      const a = session("alice");
      await a.engine.start();
      for (let i = 0; i < 250; i++) a.draw(`c${i}`, [(i % 25) * 100, Math.floor(i / 25) * 100, 50, 50]);
      await a.sched.advance(800);
      expect(a.ops().map((l) => (l.body as { ops: unknown[] }).ops.length)).toEqual([200, 50]);
      expect((await read()).annotations).toHaveLength(250);
      expect(a.view).toMatchObject({ status: "saved", version: 3 });
    });

    it("on a version conflict adopts the server's boxes and replays mine on them: both people's edits to a box survive", async () => {
      const { session, read } = await world();
      const a = session("alice");
      const b = session("bob");
      await a.engine.start();
      a.draw("a1");
      await a.sched.advance(800);
      await b.engine.start(); // bob sees a1 at version 2
      b.label("a1", "Deep Caries");
      await b.sched.advance(800); // version 3
      a.drag("a1", [20, 20, 50, 60]); // alice still works on version 2
      await a.sched.advance(800);
      expect(a.ops()).toHaveLength(3); // the refused one (409) and the resend on the server's version
      expect(a.remote.at(-1)).toEqual({ why: "rebase", ids: ["a1"] });
      expect(a.present[0]).toMatchObject({ bbox: [20, 20, 50, 60], pathology: "Deep Caries" }); // her geometry, his label
      expect(a.view).toMatchObject({ status: "merged", version: 4 });
      const s = await read();
      expect(s.annotations[0]).toMatchObject({ bbox: [20, 20, 50, 60], pathology: "Deep Caries" });
      expect(s.version).toBe(4);
      a.draw("a2", [300, 100, 50, 60]); // the next edit clears the "merged" note
      expect(a.view.status).toBe("pending");
      await a.sched.advance(800);
      expect(a.view.status).toBe("saved");
    });

    it("a box someone else deleted stays deleted when I edit it, and their new boxes appear in my editor", async () => {
      const { session, read } = await world();
      const a = session("alice");
      const b = session("bob");
      await a.engine.start();
      a.draw("a1");
      a.draw("a2", [300, 100, 50, 60]);
      await a.sched.advance(800);
      await b.engine.start();
      b.remove("a1");
      b.draw("b1", [600, 100, 50, 60]);
      await b.sched.advance(800);
      a.drag("a1", [30, 30, 50, 60]); // edits a box that no longer exists on the server
      a.draw("a3", [900, 100, 50, 60]);
      await a.sched.advance(800);
      expect(ids(a)).toEqual(["a2", "b1", "a3"]);
      expect((await read()).annotations.map((x) => x.id)).toEqual(["a2", "b1", "a3"]);
      expect(a.view.status).toBe("merged");
    });

    it("when the set is no longer a draft: becomes read-only, says the newest edits were not saved, and stops sending", async () => {
      const { session } = await world();
      const a = session("alice");
      const b = session("bob");
      await a.engine.start();
      a.draw("a1");
      await a.sched.advance(800);
      await b.engine.start();
      expect((await b.engine.transition("submit")).kind).toBe("ok");
      a.draw("a2", [300, 100, 50, 60]);
      await a.sched.advance(800);
      expect(a.view).toMatchObject({ status: "readonly", state: "submitted", message: expect.stringContaining("no longer a draft") });
      expect(a.remote.at(-1)).toEqual({ why: "state-conflict", ids: ["a1"] });
      const sent = a.ops().length;
      a.draw("a3", [600, 100, 50, 60]);
      await a.sched.advance(10_000);
      expect(a.ops()).toHaveLength(sent);
    });

    it("retries after the server's Retry-After, then backs off 1 s, 2 s, 4 s, keeping the edits and not hammering", async () => {
      const { session, read } = await world();
      const a = session("alice");
      await a.engine.start();
      const answers: (Response | "throw" | null)[] = [problem(503, {}, { "retry-after": "7" }), problem(503), "throw"];
      a.w.intercept = ({ action }) => (action === "ops" ? (answers.shift() ?? null) : null);
      a.draw("a1");
      await a.sched.advance(800);
      expect(a.view).toMatchObject({ status: "retrying", retryAt: a.sched.now() + 7000 });
      expect(a.engine.hasUnsaved()).toBe(true);
      a.draw("a2", [300, 100, 50, 60]); // editing while waiting does not add requests
      await a.sched.advance(6999);
      expect(a.ops()).toHaveLength(1);
      await a.sched.advance(1);
      expect(a.ops()).toHaveLength(2); // second 503 without Retry-After: attempt 2 → 2 s
      expect(a.view.retryAt).toBe(a.sched.now() + 2000);
      await a.sched.advance(2000);
      expect(a.ops()).toHaveLength(3); // network error: attempt 3 → 4 s
      expect(a.view.retryAt).toBe(a.sched.now() + 4000);
      await a.sched.advance(4000);
      expect(a.view.status).toBe("saved");
      expect(a.engine.hasUnsaved()).toBe(false);
      expect((await read()).annotations.map((x) => x.id)).toEqual(["a1", "a2"]); // both edits made it
      // a success resets the backoff: the next failure waits 1 s again, not 8 s
      answers.push(problem(503));
      a.draw("a3", [600, 100, 50, 60]);
      await a.sched.advance(800);
      expect(a.view.retryAt).toBe(a.sched.now() + 1000);
    });

    it("resets the backoff after a partly successful send, and after a retry that finds nothing left to send", async () => {
      const { session } = await world();
      const a = session("alice");
      await a.engine.start();
      // 250 boxes = two chunks. Request 1 fails, its retry succeeds for chunk 1, chunk 2 then fails: that failure is attempt 1 again, not 2.
      const answers: (Response | null)[] = [problem(503), null, problem(503)];
      a.w.intercept = ({ action }) => (action === "ops" ? (answers.shift() ?? null) : null);
      for (let i = 0; i < 250; i++) a.draw(`c${i}`, [(i % 25) * 100, Math.floor(i / 25) * 100, 50, 50]);
      await a.sched.advance(800);
      expect(a.view.retryAt).toBe(a.sched.now() + 1000);
      await a.sched.advance(1000);
      expect(a.ops()).toHaveLength(3);
      expect(a.view.retryAt).toBe(a.sched.now() + 1000);
      const b = session("bob");
      await b.engine.start();
      const again: (Response | null)[] = [problem(503), problem(503)];
      b.w.intercept = ({ action }) => (action === "ops" ? (again.shift() ?? null) : null);
      b.draw("b1");
      await b.sched.advance(800); // attempt 1: wait 1 s
      b.remove("b1"); // the edit is undone while waiting: nothing is left to send
      await b.sched.advance(1000);
      expect(b.view.status).toBe("saved");
      b.draw("b2");
      await b.sched.advance(800);
      expect(b.view.retryAt).toBe(b.sched.now() + 1000); // not 2 s: the idle round reset the count
    });

    it("stops merging after 5 consecutive conflicts and says so, instead of looping", async () => {
      const { session, store, orgId } = await world();
      const a = session("alice");
      await a.engine.start();
      let k = 0;
      a.w.intercept = async ({ action }) => {
        if (action !== "ops") return null;
        // someone else writes just before every attempt of alice's, so each one arrives stale
        const cur = (await (await h.getSet({ store, actor: { userId: "bob", orgId, role: "annotator" } }, "1")).json()) as { version: number };
        const body = JSON.stringify({ baseVersion: cur.version, ops: [{ type: "create", annotation: box(`z${++k}`, { author_id: "bob", bbox: [k * 60, 500, 50, 50] }), index: 0 }] });
        await h.postOps(new Request("http://localhost/api/labels/1/ops", { method: "POST", headers: { "content-type": "application/json" }, body }), { store, actor: { userId: "bob", orgId, role: "annotator" } }, "1");
        return null;
      };
      a.draw("a1");
      await a.sched.advance(800);
      expect(a.ops()).toHaveLength(6);
      expect(a.view).toMatchObject({ status: "error", message: expect.stringContaining("at once") });
      expect(ids(a)).toContain("a1"); // my edit is still in the editor
    });

    it("gives up with an error when the server keeps answering ok without ever containing my edit (no endless loop)", async () => {
      const { session } = await world();
      const a = session("alice");
      await a.engine.start();
      a.w.intercept = async ({ action }) => (action === "ops" ? h.getSet({ store: a.w.store, actor: a.w.actor() }, "1") : null);
      a.draw("a1");
      await a.sched.advance(800);
      expect(a.ops()).toHaveLength(20);
      expect(a.view).toMatchObject({ status: "error", message: expect.stringContaining("converge") });
    });

    it("moves to local mode when the session ends mid-edit, keeps the edits in memory and stops sending", async () => {
      const { session } = await world();
      const a = session("alice");
      await a.engine.start();
      a.cur.actor = null;
      a.draw("a1");
      await a.sched.advance(800);
      expect(a.view).toMatchObject({ mode: "local", localReason: "session-lost" });
      expect(ids(a)).toEqual(["a1"]);
      const sent = a.w.log.length;
      a.draw("a2", [300, 100, 50, 60]);
      await a.sched.advance(60_000);
      expect(a.w.log).toHaveLength(sent);
    });

    it("shows a refused edit as an error without retrying by itself, and tries again on the next edit", async () => {
      const { session, read } = await world();
      const a = session("alice");
      await a.engine.start();
      a.w.intercept = ({ action }) => (action === "ops" ? problem(422, { detail: "box a1 lies outside the image" }) : null);
      a.draw("a1");
      await a.sched.advance(800);
      expect(a.view).toMatchObject({ status: "error", message: "box a1 lies outside the image" });
      await a.sched.advance(120_000);
      expect(a.ops()).toHaveLength(1);
      a.w.intercept = undefined;
      a.draw("a2", [300, 100, 50, 60]);
      await a.sched.advance(800);
      expect(a.view.status).toBe("saved");
      expect((await read()).annotations.map((x) => x.id)).toEqual(["a1", "a2"]);
    });

    it("submits only after saving what is pending, adopts the new state, then refuses edits", async () => {
      const { session, read } = await world();
      const a = session("alice");
      await a.engine.start();
      a.draw("a1"); // still inside the debounce
      const r = await a.engine.transition("submit");
      expect(r.kind).toBe("ok");
      expect(a.w.log.map((l) => l.action)).toEqual(["status", "open", "ops", "transition"]);
      expect(a.view).toMatchObject({ status: "readonly", state: "submitted", version: 3 });
      expect(a.remote.at(-1)).toMatchObject({ why: "transition", ids: ["a1"] });
      expect((await read()).state).toBe("submitted");
      a.draw("a2", [300, 100, 50, 60]);
      await a.sched.advance(5000);
      expect(a.ops()).toHaveLength(1);
    });

    it("does not change the set's state while edits are unsaved", async () => {
      const { session, read } = await world();
      const a = session("alice");
      await a.engine.start();
      a.w.intercept = ({ action }) => (action === "ops" ? problem(503) : null);
      a.draw("a1");
      const r = await a.engine.transition("submit");
      expect(r).toMatchObject({ kind: "invalid", message: expect.stringContaining("not saved") });
      expect(a.w.log.some((l) => l.action === "transition")).toBe(false);
      expect((await read()).state).toBe("draft");
    });

    it("lets a reviewer approve someone else's set, and refuses self-review", async () => {
      const { session, read } = await world();
      const a = session("alice");
      await a.engine.start();
      a.draw("a1");
      await a.engine.transition("submit");
      const rita = session("rita", "reviewer");
      await rita.engine.start();
      expect(rita.view.status).toBe("readonly");
      expect((await rita.engine.transition("approve")).kind).toBe("ok");
      expect(rita.view.state).toBe("approved");
      expect((await read()).state).toBe("approved");
      const root = session("root", "admin");
      const other = await world(); // a separate org: root's own set
      const own = other.session("root", "admin");
      void root;
      await own.engine.start();
      own.draw("c1");
      await own.engine.transition("submit");
      expect(await own.engine.transition("approve")).toMatchObject({ kind: "forbidden" });
    });

    it("stop() also cancels a pending retry", async () => {
      const { session } = await world();
      const a = session("alice");
      await a.engine.start();
      a.w.intercept = ({ action }) => (action === "ops" ? problem(503, {}, { "retry-after": "5" }) : null);
      a.draw("a1");
      await a.sched.advance(800);
      expect(a.view.status).toBe("retrying");
      a.engine.stop();
      expect(a.sched.pending()).toBe(0); // the retry timer is gone at once, not merely harmless when it fires
      await a.sched.advance(60_000);
      expect(a.ops()).toHaveLength(1);
    });

    it("flushOnExit sends the pending edits with keepalive; stop() cancels timers and requests", async () => {
      const { session, read } = await world();
      const a = session("alice");
      await a.engine.start();
      a.draw("a1");
      a.engine.flushOnExit();
      await a.sched.advance(0);
      expect(a.ops()).toHaveLength(1);
      expect(a.ops()[0]!.keepalive).toBe(true);
      expect((await read()).annotations.map((x) => x.id)).toEqual(["a1"]);
      const b = session("bob");
      await b.engine.start();
      b.draw("b1");
      b.engine.stop();
      await b.sched.advance(60_000);
      expect(b.ops()).toHaveLength(0);
      expect(b.sched.pending()).toBe(0);
    });
  });
}

describe("backoff", () => {
  it("doubles from 1 s and is capped at 30 s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });
});

define("memory", async () => new MemoryStore());
define("drizzle", async () => new DrizzleOrgStore(getPgDb()), !dbUp);
