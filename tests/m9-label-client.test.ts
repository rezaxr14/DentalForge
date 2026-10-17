/** The browser client of /api/labels (ADR-0020): every server answer becomes one typed result; nothing throws. */
import { describe, expect, it } from "vitest";
import { createLabelClient } from "@/shared/labels/client";
import type { SetDto } from "@/shared/labels/dto";
import { box } from "./helpers/annotation-repo-suite";

const dto: SetDto = {
  viewer: { userId: "alice", role: "annotator" },
  version: 3,
  state: "draft",
  assigneeId: "alice",
  submittedAt: null,
  image: { width: 2744, height: 1316 },
  annotations: [box("a1")],
};
const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const clientFor = (r: () => Response | Promise<Response>, seen: { url?: string; init?: RequestInit }[] = []) =>
  createLabelClient((async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return r();
  }) as typeof fetch);

describe("label client", () => {
  it("sends the documented requests: id encoded, JSON body only on POST, keepalive only when asked", async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const c = clientFor(() => res(200, dto), seen);
    await c.get("a b/1");
    await c.open("1");
    await c.ops("1", 3, [{ type: "delete" }], { keepalive: true });
    await c.ops("1", 3, []);
    await c.transition("1", { transition: "submit", baseVersion: 3 });
    expect(seen.map((s) => `${s.init?.method} ${s.url}`)).toEqual([
      "GET /api/labels/a%20b%2F1",
      "POST /api/labels/1/open",
      "POST /api/labels/1/ops",
      "POST /api/labels/1/ops",
      "POST /api/labels/1/transition",
    ]);
    expect(seen[0]!.init!.body).toBeUndefined();
    expect((seen[0]!.init!.headers as Record<string, string>)["content-type"]).toBeUndefined();
    expect(JSON.parse(seen[2]!.init!.body as string)).toEqual({ baseVersion: 3, ops: [{ type: "delete" }] });
    expect(seen[2]!.init!.keepalive).toBe(true);
    expect(seen[3]!.init!.keepalive).toBeUndefined();
    expect((seen[2]!.init!.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(seen[4]!.init!.body as string)).toEqual({ baseVersion: 3, transition: "submit" });
    expect(seen[0]!.init!.credentials).toBe("same-origin");
  });

  it("asks /status and maps it: available, signed-out, unavailable, and any failure to unavailable (never throws)", async () => {
    const st = (r: () => Response | Promise<Response>) => clientFor(r).status();
    expect(await st(() => res(200, { available: true, reason: null }))).toEqual({ kind: "available" });
    expect(await st(() => res(200, { available: false, reason: "signed-out" }))).toEqual({ kind: "signed-out" });
    expect(await st(() => res(200, { available: false, reason: "unavailable" }))).toMatchObject({ kind: "unavailable" });
    expect(await st(() => res(500, {}))).toMatchObject({ kind: "unavailable", message: "Server answered HTTP 500" });
    expect(await st(() => res(200, "<html>proxy</html>"))).toMatchObject({ kind: "unavailable" });
    expect(await st(() => { throw new TypeError("Failed to fetch"); })).toEqual({ kind: "unavailable", message: "Failed to fetch" });
    const seen: { url?: string; init?: RequestInit }[] = [];
    await clientFor(() => res(200, { available: true }), seen).status();
    expect(`${seen[0]!.init?.method} ${seen[0]!.url}`).toBe("GET /api/labels/status");
  });

  it("maps every status to one result", async () => {
    const problem = (status: number, detail: string) => res(status, { code: "x", title: "T", detail }, { "content-type": "application/problem+json" });
    const kind = async (r: Response) => (await clientFor(() => r).get("1"));
    expect(await kind(res(200, dto))).toEqual({ kind: "ok", value: dto });
    expect(await kind(res(401, {}))).toEqual({ kind: "unauthorized" });
    expect(await kind(problem(403, "no"))).toEqual({ kind: "forbidden", message: "no" });
    expect(await kind(res(404, {}))).toEqual({ kind: "notFound" });
    for (const s of [400, 413, 415, 422]) expect(await kind(problem(s, "bad box"))).toEqual({ kind: "invalid", message: "bad box" });
    expect(await kind(res(422, {}))).toMatchObject({ kind: "invalid", message: expect.stringContaining("422") });
    expect(await kind(res(409, { code: "conflict", reason: "version", set: dto }))).toEqual({ kind: "conflict", reason: "version", set: dto });
    expect(await kind(res(409, { code: "conflict", reason: "state", set: dto }))).toEqual({ kind: "conflict", reason: "state", set: dto });
  });

  it("treats 5xx, 429, network errors and unreadable answers as unavailable, honouring Retry-After in seconds", async () => {
    const un = async (r: () => Response | Promise<Response>) => clientFor(r).ops("1", 1, []);
    expect(await un(() => res(503, {}, { "retry-after": "15" }))).toMatchObject({ kind: "unavailable", retryAfterMs: 15_000 });
    expect(await un(() => res(429, {}, { "retry-after": "2" }))).toMatchObject({ kind: "unavailable", retryAfterMs: 2000 });
    expect(await un(() => res(500, {}))).toMatchObject({ kind: "unavailable", retryAfterMs: null });
    expect(await un(() => res(503, {}, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }))).toMatchObject({ retryAfterMs: null }); // dates are not used by this API
    expect(await un(() => res(503, {}, { "retry-after": "99999" }))).toMatchObject({ retryAfterMs: 300_000 }); // capped
    expect(await un(() => { throw new TypeError("Failed to fetch"); })).toEqual({ kind: "unavailable", retryAfterMs: null, message: "Failed to fetch" });
    expect(await un(() => res(200, "<html>proxy error</html>"))).toMatchObject({ kind: "unavailable" });
    expect(await un(() => res(200, { ...dto, version: 0 }))).toMatchObject({ kind: "unavailable" }); // fails the schema
    expect(await un(() => res(409, { code: "conflict", reason: "version" }))).toMatchObject({ kind: "unavailable" }); // no set to adopt
    expect(await un(() => res(409, { code: "conflict", reason: "other", set: dto }))).toMatchObject({ kind: "unavailable" });
  });
});
