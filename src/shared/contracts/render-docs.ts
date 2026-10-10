/**
 * Renders `docs/worker-contract.md` from the generated OpenAPI document, so the
 * prose reference can never disagree with the schemas the handlers enforce.
 * (Deterministic: same input → byte-identical output; a test enforces sync.)
 */
type Json = Record<string, unknown>;

const code = (o: unknown) => "```json\n" + JSON.stringify(o, null, 2) + "\n```";

export function renderContractMarkdown(doc: Json): string {
  const paths = doc.paths as Record<string, Record<string, Json>>;
  const schemas = (doc.components as { schemas: Record<string, Json> }).schemas;
  const jobTypes = doc["x-job-types"] as Record<string, { payload: { $ref: string }; result: { $ref: string } }>;
  const refName = (r: { $ref: string }) => r.$ref.split("/").pop()!;

  const out: string[] = [];
  out.push(`# Worker contract v${(doc.info as Json).version}`);
  out.push("");
  out.push("> **Generated** from the zod schemas in `src/shared/contracts/` by `pnpm contract:docs`. Do not edit by hand —");
  out.push("> `tests/m8-contract-docs.test.ts` fails CI if this file or `docs/worker-openapi.json` is stale.");
  out.push("");
  out.push("The worker is **pull-based and outbound-only**: it polls the web app; the web app never calls a worker. That is what lets a");
  out.push("home GPU box behind NAT, a Colab/Kaggle session, or a cloud server all attach to a Vercel deployment.");
  out.push("");
  out.push("## Conventions");
  out.push("");
  out.push("| | |");
  out.push("|---|---|");
  out.push("| Base path | `/api/worker/v1` |");
  out.push("| Auth | `Authorization: Bearer tf_wrk_<random>` — org-scoped, stored hashed, shown once. Scopes: `jobs:read` < `jobs:write` < `admin` |");
  out.push("| Version | `X-Contract-Version: 1` is **required**. Missing → `400`; unknown major → `426` with `supported: [1]` |");
  out.push("| Worker identity | Job-write endpoints (`events`, `artifacts/presign`, `complete`, `fail`) require `X-Worker-Id` (the id from `/register`). It fences writes to the current lease holder (ADR-0009) |");
  out.push("| Errors | RFC 9457 `application/problem+json` with a stable `code` member |");
  out.push("| Idempotency | `events` are idempotent on `seq`; `complete`/`fail` replay safely for the lease holder; `register` upserts by `name` |");
  out.push("");
  out.push("### Job lifecycle");
  out.push("");
  out.push("`queued → claimed → running → succeeded | failed | cancelled | expired`");
  out.push("");
  out.push("- **Lease.** `claim` leases a job for `leaseSeconds` (default 60). Every `events` call and heartbeat renews it. If it lapses the job is");
  out.push("  **lazily reaped** (no cron): back to `queued` while attempts remain (max 3), else `expired`. Queued jobs expire after 7 days.");
  out.push("- **Fencing.** After a reap, the old holder's writes get `409 job_not_owner` — stop working on it. A cancelled job gets `409 job_cancelled`");
  out.push("  (and its id appears in the next heartbeat's `cancelJobIds`). A finished job gets `409 job_terminal`.");
  out.push("- **Failure.** `fail` with `retryable: true` requeues while attempts remain (`attemptsRemaining` says how many); otherwise the job is `failed`.");
  out.push("- **Long-poll.** `claim` waits up to `waitMs` (≤ 20 000) and returns `{ jobs: [] }` — never an error — when nothing arrives.");
  out.push("- **Database down.** Every endpoint answers `503` + `Retry-After`; keep polling, do not treat it as a bad token.");
  out.push("- **Uploads.** Artifacts go to a presigned URL, never through the API. The URL pins size and SHA-256 and expires in 15 minutes.");
  out.push("");
  out.push("### Problem codes");
  out.push("");
  out.push("`invalid_request` · `validation_failed` · `unauthorized` · `forbidden` · `unknown_worker` · `not_found` · `unsupported_contract_version` ·");
  out.push("`job_not_owner` · `job_cancelled` · `job_terminal` · `worker_integration_off` · `unavailable` · `not_implemented` · `internal`");
  out.push("");
  out.push("## Endpoints");
  out.push("");
  out.push("| Method | Path | Summary | Status |");
  out.push("|---|---|---|---|");
  for (const [p, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      const impl = op["x-implemented"] === false ? "not implemented (501)" : "implemented";
      out.push(`| ${method.toUpperCase()} | \`${p}\` | ${op.summary as string} | ${impl} |`);
    }
  }
  out.push("");
  out.push("Request/response bodies are listed under **Schemas** below.");
  out.push("");
  out.push("## Job types");
  out.push("");
  out.push("| Type | Payload schema | Result schema |");
  out.push("|---|---|---|");
  for (const [t, d] of Object.entries(jobTypes)) out.push(`| \`${t}\` | \`${refName(d.payload)}\` | \`${refName(d.result)}\` |`);
  out.push("");
  out.push("`system.ping` is a contract-level diagnostic (not in plan §10.2): it lets an operator verify the whole pipe with no GPU.");
  out.push("");
  out.push("## Schemas");
  for (const [name, schema] of Object.entries(schemas)) {
    out.push("");
    out.push(`### ${name}`);
    out.push("");
    out.push(code(schema));
  }
  out.push("");
  return out.join("\n");
}
