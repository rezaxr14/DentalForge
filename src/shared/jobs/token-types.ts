/**
 * Pure constants and types for worker-token administration. NO Node imports
 * (no `node:crypto`, no DB): this module is imported by the `/settings` client
 * component, so it must stay safe to bundle for the browser.
 */
import { z } from "zod";

export const TOKEN_NAME_MAX = 64;
/** Active (non-revoked) tokens per org. Bounds blast radius and UI size. */
export const MAX_ACTIVE_TOKENS = 20;

export const TOKEN_SCOPES = ["jobs:read", "jobs:write", "admin"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export const SCOPE_HELP: Record<TokenScope, string> = {
  "jobs:read": "Read job status and images only.",
  "jobs:write": "Claim jobs, stream events, upload results (a normal worker).",
  // Honest: no worker endpoint requires more than jobs:write today (worker-handlers.ts).
  admin: "Highest scope. Currently behaves like jobs:write; reserved for future admin endpoints.",
};

/** Scopes the settings UI offers. `admin` stays CLI-only until an endpoint needs it (least privilege). */
export const UI_TOKEN_SCOPES = ["jobs:write", "jobs:read"] as const satisfies readonly TokenScope[];

export const CreateTokenInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the token a name")
    .max(TOKEN_NAME_MAX, `At most ${TOKEN_NAME_MAX} characters`),
  scope: z.enum(TOKEN_SCOPES).default("jobs:write"),
});
export type CreateTokenInput = z.input<typeof CreateTokenInput>;

/** What the UI may see about a token. Deliberately has no `tokenHash`. */
export interface WorkerTokenSummary {
  id: string;
  name: string;
  scope: TokenScope;
  /** ISO-8601. Strings, so the shape crosses the server-action boundary unchanged. */
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
