/** What the editor tells the user about where their boxes live (ADR-0020): every state has its own words and tone. */
import { describe, expect, it } from "vitest";
import { describeSync } from "../src/app/labels/[imageId]/sync-badge";
import type { LocalReason, SyncStatus, SyncView } from "@/shared/labels/sync-engine";

const view = (over: Partial<SyncView>): SyncView => ({
  mode: "server", localReason: null, status: "saved", message: null, retryAt: null, version: 3, state: "draft",
  viewer: { userId: "u1", role: "annotator" }, assigneeId: "u1", ...over,
});

describe("describeSync", () => {
  it("says it is connecting until the engine has decided", () => {
    expect(describeSync(null)).toEqual({ tone: "info", text: "Connecting…", detail: null });
    expect(describeSync(view({ mode: "connecting", status: "loading" })).text).toBe("Connecting…");
    expect(describeSync(view({ status: "loading" })).text).toBe("Connecting…");
  });

  it("every server status has distinct, specific words", () => {
    const cases: [SyncStatus, Partial<SyncView>, string, string, RegExp | null][] = [
      ["saved", {}, "ok", "Saved to server", null],
      ["merged", {}, "ok", "Saved · merged with others' changes", /both kept/],
      ["pending", {}, "info", "Unsaved changes", null],
      ["saving", {}, "info", "Saving…", null],
      ["retrying", { message: "Server answered HTTP 503" }, "warn", "Offline · will retry", /HTTP 503.*do not close/],
      ["error", { message: "box a1 lies outside the image" }, "bad", "Not saved", /outside the image/],
      ["readonly", { state: "submitted", message: null }, "info", "Read-only · submitted", /submitted, so it can no longer be edited/],
    ];
    for (const [status, over, tone, text, detail] of cases) {
      const d = describeSync(view({ status, ...over }));
      expect([status, d.tone, d.text]).toEqual([status, tone, text]);
      if (detail) expect(d.detail).toMatch(detail);
      else expect(d.detail).toBeNull();
    }
    const texts = cases.map(([s, o]) => describeSync(view({ status: s, ...o })).text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("read-only because of a role (state still draft) says so without inventing a state, and prefers the server's message", () => {
    expect(describeSync(view({ status: "readonly", state: "draft", message: "Your role cannot edit annotations" }))).toMatchObject({
      text: "Read-only", detail: "Your role cannot edit annotations",
    });
  });

  it("local mode always says 'this browser only', in the warning tone, with the reason", () => {
    const reasons: [LocalReason, RegExp][] = [
      ["signed-out", /not signed in, or no organization is selected/],
      ["server-unavailable", /could not be reached/],
      ["forbidden", /Your role cannot open images/],
      ["session-lost", /You were signed out/],
    ];
    for (const [localReason, detail] of reasons) {
      const d = describeSync(view({ mode: "local", localReason }));
      expect(d).toMatchObject({ tone: "warn", text: "Saved in this browser only" });
      expect(d.detail).toMatch(detail);
    }
    expect(describeSync(view({ mode: "local", localReason: "forbidden", message: "Custom reason" })).detail).toBe("Custom reason");
  });
});
