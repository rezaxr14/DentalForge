import { describe, expect, it } from "vitest";
import { createRateLimiter, isSameOrigin } from "@/shared/lib/rate-limit";

describe("createRateLimiter", () => {
  it("allows up to max then blocks with retryAfterMs", () => {
    const rl = createRateLimiter({ max: 2, windowMs: 1000 });
    expect(rl.check("k", 0).ok).toBe(true);
    expect(rl.check("k", 10).ok).toBe(true);
    const r = rl.check("k", 20);
    expect(r.ok).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  it("resets after the window", () => {
    const rl = createRateLimiter({ max: 1, windowMs: 1000 });
    expect(rl.check("k", 0).ok).toBe(true);
    expect(rl.check("k", 500).ok).toBe(false);
    expect(rl.check("k", 1001).ok).toBe(true);
  });

  it("keys are independent", () => {
    const rl = createRateLimiter({ max: 1, windowMs: 1000 });
    expect(rl.check("a", 0).ok).toBe(true);
    expect(rl.check("b", 0).ok).toBe(true);
    expect(rl.check("a", 0).ok).toBe(false);
  });

  it("reset() clears all buckets", () => {
    const rl = createRateLimiter({ max: 1, windowMs: 1000 });
    rl.check("k", 0);
    rl.reset();
    expect(rl.check("k", 0).ok).toBe(true);
  });
});

describe("isSameOrigin", () => {
  it("accepts matching origin", () => {
    const req = new Request("http://app/x", { headers: { origin: "http://app" } });
    expect(isSameOrigin(req, "http://app")).toBe(true);
  });
  it("rejects foreign origin", () => {
    const req = new Request("http://app/x", { headers: { origin: "http://evil" } });
    expect(isSameOrigin(req, "http://app")).toBe(false);
  });
  it("falls back to referer when origin absent", () => {
    const req = new Request("http://app/x", { headers: { referer: "http://app/y" } });
    expect(isSameOrigin(req, "http://app")).toBe(true);
  });
  it("accepts when neither origin nor referer present", () => {
    const req = new Request("http://app/x");
    expect(isSameOrigin(req, "http://app")).toBe(true);
  });
});
