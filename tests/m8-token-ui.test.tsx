/**
 * M8 task B — `/settings` worker-token manager, server-rendered with initial
 * props (no browser tooling yet: interaction is covered by the core suite in
 * m8-token-admin.test.ts; Playwright is task E). Pins what an admin sees on
 * first paint and that nothing secret can reach the markup.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The real module is a "use server" file that pulls in the auth stack; the UI only needs the names.
vi.mock("@/shared/lib/worker-token-actions", () => ({
  createWorkerTokenAction: vi.fn(),
  revokeWorkerTokenAction: vi.fn(),
  listWorkerTokensAction: vi.fn(),
}));

const { WorkerTokenManager, formatUtc } = await import("@/app/settings/worker-tokens");
import type { WorkerTokenSummary } from "@/shared/jobs/token-types";

const tok = (over: Partial<WorkerTokenSummary>): WorkerTokenSummary => ({
  id: "t1",
  name: "rtx4090-box",
  scope: "jobs:write",
  createdAt: "2026-10-10T14:26:23.074Z",
  lastUsedAt: null,
  revokedAt: null,
  ...over,
});

describe("formatUtc", () => {
  it("is deterministic (UTC, no locale) so server and client renders match", () => {
    expect(formatUtc("2026-10-10T14:26:23.074Z")).toBe("2026-10-10 14:26 UTC");
    expect(formatUtc(null)).toBe("never");
  });
});

describe("WorkerTokenManager first paint", () => {
  it("shows an empty state and a disabled create button when there are no tokens", () => {
    const html = renderToStaticMarkup(<WorkerTokenManager orgId="o1" orgName="Demo" initialTokens={[]} />);
    expect(html).toContain("No active tokens.");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Create token<\/button>/); // empty name → cannot submit
    expect(html).not.toContain("Revoked (");
  });

  it("lists active tokens with scope, created and last-used, and folds revoked ones away", () => {
    const html = renderToStaticMarkup(
      <WorkerTokenManager
        orgId="o1"
        orgName="Demo"
        initialTokens={[
          tok({ id: "a", name: "colab", lastUsedAt: "2026-10-10T15:00:00.000Z" }),
          tok({ id: "b", name: "old-kaggle", scope: "jobs:read", revokedAt: "2026-10-09T09:00:00.000Z" }),
        ]}
      />,
    );
    expect(html).toContain("colab");
    expect(html).toContain("Last used 2026-10-10 15:00 UTC");
    expect(html).toContain('aria-label="Revoke token colab"');
    expect(html).toContain("Revoked (1)");
    expect(html).toContain("old-kaggle");
    expect(html).not.toContain('aria-label="Revoke token old-kaggle"'); // revoked tokens cannot be revoked again
  });

  it("offers only least-privilege scopes (admin scope stays CLI-only) and never renders a token or hash", () => {
    const html = renderToStaticMarkup(<WorkerTokenManager orgId="o1" orgName="Demo" initialTokens={[tok({})]} />);
    expect(html).toContain('<option value="jobs:write"');
    expect(html).toContain('<option value="jobs:read"');
    expect(html).not.toContain('<option value="admin"');
    expect(html).not.toMatch(/tf_wrk_/);
    expect(html).not.toMatch(/tokenHash/i);
    expect(html).not.toContain("will not be shown again"); // the one-time reveal exists only after a successful create
  });
});
