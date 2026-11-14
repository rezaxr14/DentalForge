/**
 * The Content-Security-Policy must let the Next.js App Router hydrate (ADR-0028 amendment).
 *
 * Regression: `script-src 'self'` blocked every inline bootstrap script, React never hydrated and every page of the
 * production build was static HTML with dead controls. Unit tests cannot see hydration, so e2e/security-headers.spec.ts
 * proves it in a browser; this file pins the policy text and the fact that there is a single definition of it.
 */
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { CONTENT_SECURITY_POLICY, CSP_DIRECTIVES, SECURITY_HEADERS } from "@/shared/lib/csp";
import { securityHeaders } from "@/shared/lib/middleware/security";

const directives = new Map(CONTENT_SECURITY_POLICY.split("; ").map((d) => [d.split(" ")[0]!, d.split(" ").slice(1)] as const));

describe("Content-Security-Policy", () => {
  it("lets inline scripts run, because Next's bootstrap and hydration payload are inline", () => {
    expect(directives.get("script-src")).toEqual(expect.arrayContaining(["'self'", "'unsafe-inline'"]));
  });

  it("stays closed everywhere else: same origin, no framing, no plugins, no <base> or foreign form targets", () => {
    expect(directives.get("default-src")).toEqual(["'self'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("base-uri")).toEqual(["'self'"]);
    expect(directives.get("form-action")).toEqual(["'self'"]);
    expect(directives.get("connect-src")).toEqual(["'self'"]);
  });

  it("never opens scripts to the network or to eval, and has no wildcard source anywhere", () => {
    const script = directives.get("script-src")!;
    for (const bad of ["*", "http:", "https:", "data:", "blob:", "'unsafe-eval'"]) {
      expect(script, bad).not.toContain(bad);
    }
    expect(CSP_DIRECTIVES.some((d) => /(^|\s)\*(\s|$)/.test(d))).toBe(false);
  });

  it("allows WebAssembly compilation for the browser YOLO, and nothing wider than that", () => {
    // onnxruntime-web compiles the ONNX graph with WebAssembly.instantiate; without this token Chromium refuses it
    // and the browser pre-label tier dies after a 50 MB download. ADR-0027.
    const script = directives.get("script-src")!;
    expect(script).toContain("'wasm-unsafe-eval'");
    expect(script).not.toContain("'unsafe-eval'");
    // The worker is same-origin, so it needs no blob: or CDN source.
    expect(directives.get("worker-src")).toEqual(["'self'"]);
  });

  it("has exactly one definition: next.config sends it once for every path, and the API fallback is identical", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1); // "/:path*" already covers "/api/..."; a second block would duplicate every header
    expect(rules[0]!.source).toBe("/:path*");
    const sent = new Map(rules[0]!.headers.map((h) => [h.key, h.value]));
    expect(sent.get("Content-Security-Policy")).toBe(CONTENT_SECURITY_POLICY);
    expect(rules[0]!.headers).toHaveLength(SECURITY_HEADERS.length);
    expect(securityHeaders()["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
  });

  it("keeps the other security headers", () => {
    const sent = new Map(SECURITY_HEADERS.map((h) => [h.key, h.value]));
    expect(sent.get("X-Content-Type-Options")).toBe("nosniff");
    expect(sent.get("X-Frame-Options")).toBe("DENY");
    expect(sent.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(sent.get("Strict-Transport-Security")).toContain("max-age=31536000");
  });
});
