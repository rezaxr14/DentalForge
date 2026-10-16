/**
 * LabelForge persistence over HTTP with REAL sessions (ADR-0019): Better Auth users and organisations, the cookie the app
 * uses, `next start` against Postgres. API-only (no browser page); it proves what the handler tests cannot: that the
 * session → active org → membership role wiring reaches the handlers, and that two real organisations stay apart.
 */
import { expect, request as pwRequest, test, type APIRequestContext } from "@playwright/test";
import { DB_URL, SECRETS, startApp, type RunningApp } from "./support/app";

let app: RunningApp;
test.beforeAll(async () => {
  app = await startApp({ ...SECRETS, DATABASE_URL: DB_URL, WORKER_MODE: "off" });
});
test.afterAll(async () => app.stop());

interface User {
  api: APIRequestContext;
  id: string;
}

/** A real signed-in user with its own cookie jar; optionally the admin of a fresh organisation. */
async function newUser(tag: string, { org }: { org: boolean }): Promise<User> {
  const api = await pwRequest.newContext({ baseURL: app.base });
  const uid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const headers = { origin: app.base };
  // Better Auth rate-limits sign-ups per IP (a few per 10 s). That is the server doing its job, not a failure of the
  // thing under test: wait out the window it names and try again.
  let su = await api.post("/api/auth/sign-up/email", {
    headers,
    data: { email: `${tag}-${uid}@example.com`, password: "browser-e2e-pass-123", name: `Label ${tag}` },
  });
  for (let attempt = 0; su.status() === 429 && attempt < 3; attempt++) {
    const wait = Number(su.headers()["x-retry-after"] ?? "11") + 1;
    await new Promise((r) => setTimeout(r, wait * 1000));
    su = await api.post("/api/auth/sign-up/email", {
      headers,
      data: { email: `${tag}-${uid}@example.com`, password: "browser-e2e-pass-123", name: `Label ${tag}` },
    });
  }
  expect(su.ok(), `sign up -> ${su.status()} ${(await su.text()).slice(0, 200)}`).toBe(true);
  const id = ((await su.json()) as { user: { id: string } }).user.id;
  if (org) {
    const o = await api.post("/api/auth/organization/create", { headers, data: { name: `Lab ${uid}`, slug: `lab-${uid}` } });
    expect(o.ok(), "create organization").toBe(true);
  }
  return { api, id };
}

const box = (id: string, author: string, over: Record<string, unknown> = {}) => ({
  id, bbox: [100, 100, 50, 60], fdi_quadrant: 1, fdi_position: 6, pathology: "Caries",
  source: "human", confidence: null, status: "draft", version: 1, author_id: author, ...over,
});
const create = (annotation: object, index: number) => ({ type: "create", annotation, index });
const json = { "content-type": "application/json" };

test("a signed-in admin opens an image, edits it, rebases after a conflict and submits; the set persists", async () => {
  const a = await newUser("a", { org: true });
  expect((await a.api.get("/api/labels/1")).status()).toBe(404); // not opened yet

  const opened = await a.api.post("/api/labels/1/open");
  expect(opened.status()).toBe(200);
  expect(await opened.json()).toMatchObject({ version: 1, state: "draft", assigneeId: a.id, annotations: [] });

  const put = (baseVersion: number, ops: object[]) => a.api.post("/api/labels/1/ops", { headers: json, data: { baseVersion, ops } });
  const first = await put(1, [create(box("new_1", a.id), 0)]);
  expect(first.status()).toBe(200);
  expect((await first.json()).version).toBe(2);

  const stale = await put(1, [create(box("new_2", a.id), 1)]);
  expect(stale.status()).toBe(409);
  expect(stale.headers()["content-type"]).toContain("problem+json");
  const conflict = await stale.json();
  expect(conflict).toMatchObject({ code: "conflict", reason: "version" });
  expect(conflict.set.version).toBe(2);
  const rebased = await put(conflict.set.version, [create(box("new_2", a.id), 1)]);
  expect(rebased.status()).toBe(200);

  // what a reload sees
  const reload = await (await a.api.get("/api/labels/1")).json();
  expect(reload.version).toBe(3);
  expect(reload.annotations.map((x: { id: string }) => x.id)).toEqual(["new_1", "new_2"]);

  const submitted = await a.api.post("/api/labels/1/transition", { headers: json, data: { transition: "submit", baseVersion: 3 } });
  expect(submitted.status()).toBe(200);
  expect(await submitted.json()).toMatchObject({ state: "submitted", version: 4 });
  const late = await put(4, [create(box("late", a.id), 2)]);
  expect(late.status()).toBe(409);
  expect(await late.json()).toMatchObject({ reason: "state" });
});

test("nobody decides their own work, even an organisation admin", async () => {
  const a = await newUser("self", { org: true });
  await a.api.post("/api/labels/2/open");
  await a.api.post("/api/labels/2/ops", { headers: json, data: { baseVersion: 1, ops: [create(box("new_1", a.id), 0)] } });
  await a.api.post("/api/labels/2/transition", { headers: json, data: { transition: "submit", baseVersion: 2 } });
  const self = await a.api.post("/api/labels/2/transition", { headers: json, data: { transition: "approve", baseVersion: 3 } });
  expect(self.status()).toBe(403);
  expect((await (await a.api.get("/api/labels/2")).json()).state).toBe("submitted");
});

test("two real organisations stay apart, even for the same image and the same box id", async () => {
  const a = await newUser("iso-a", { org: true });
  const b = await newUser("iso-b", { org: true });
  await a.api.post("/api/labels/1/open");
  await a.api.post("/api/labels/1/ops", { headers: json, data: { baseVersion: 1, ops: [create(box("pred_1_3", a.id), 0)] } });

  expect((await b.api.get("/api/labels/1")).status()).toBe(404); // A's work is invisible to B
  await b.api.post("/api/labels/1/open");
  expect((await (await b.api.get("/api/labels/1")).json()).annotations).toEqual([]);
  const wb = await b.api.post("/api/labels/1/ops", {
    headers: json,
    data: { baseVersion: 1, ops: [create(box("pred_1_3", b.id, { bbox: [5, 5, 10, 10] }), 0)] },
  });
  expect(wb.status()).toBe(200);

  const sa = await (await a.api.get("/api/labels/1")).json();
  const sb = await (await b.api.get("/api/labels/1")).json();
  expect(sa.annotations).toHaveLength(1);
  expect(sa.annotations[0]).toMatchObject({ author_id: a.id, bbox: [100, 100, 50, 60] });
  expect(sb.annotations[0]).toMatchObject({ author_id: b.id, bbox: [5, 5, 10, 10] });
  expect([sa.version, sb.version]).toEqual([2, 2]);
  // B cannot write as A either: the author must be the signed-in user
  const spoof = await b.api.post("/api/labels/1/ops", { headers: json, data: { baseVersion: 2, ops: [create(box("x", a.id), 1)] } });
  expect(spoof.status()).toBe(422);
});

test("a signed-in user without an organisation, and a signed-out caller, are both 401; a non-JSON body is 415", async () => {
  const solo = await newUser("solo", { org: false });
  for (const r of [await solo.api.get("/api/labels/1"), await solo.api.post("/api/labels/1/open")]) expect(r.status()).toBe(401);

  const anon = await pwRequest.newContext({ baseURL: app.base });
  expect((await anon.get("/api/labels/1")).status()).toBe(401);
  expect((await anon.post("/api/labels/1/ops", { headers: json, data: { baseVersion: 1, ops: [] } })).status()).toBe(401);

  const a = await newUser("ct", { org: true });
  await a.api.post("/api/labels/1/open");
  const plain = await a.api.post("/api/labels/1/ops", { headers: { "content-type": "text/plain" }, data: JSON.stringify({ baseVersion: 1, ops: [] }) });
  expect(plain.status()).toBe(415);
  expect((await a.api.get("/api/labels/999")).status()).toBe(404);
});
