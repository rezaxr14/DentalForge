/**
 * In the browser zod must not probe `Function("")` (it fires a CSP violation, see src/shared/lib/zod-browser.ts);
 * on the server it keeps its JIT.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

describe("zod runtime settings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    z.config({ jitless: false });
  });

  it("turns the JIT off when a window exists (browser)", async () => {
    z.config({ jitless: false });
    vi.stubGlobal("window", {});
    vi.resetModules();
    await import("@/shared/lib/zod-browser");
    expect(z.config().jitless).toBe(true);
  });

  it("leaves the JIT on without a window (server, tests, scripts)", async () => {
    z.config({ jitless: false });
    vi.resetModules();
    await import("@/shared/lib/zod-browser");
    expect(z.config().jitless).toBe(false);
  });

  it("schemas still parse with the JIT off", () => {
    z.config({ jitless: true });
    const S = z.object({ id: z.string(), n: z.number().int() });
    expect(S.parse({ id: "a", n: 3 })).toEqual({ id: "a", n: 3 });
    expect(S.safeParse({ id: "a", n: 1.5 }).success).toBe(false);
  });
});
