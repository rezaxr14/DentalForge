/**
 * Drizzle schema (plan §7) — single source of truth for dev Docker Postgres
 * and prod Neon. Every tenant-scoped table carries `org_id` and indexes it.
 *
 * IDs are uuidv7 (sortable) generated app-side via `pk()`; drizzle-kit
 * generates SQL migrations under `drizzle/`.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** uuidv7: 48-bit unix-ms timestamp prefix + version/variant + randomness. */
export function uuidv7(now = Date.now()): string {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, Math.floor(now / 0x10000));
  view.setUint16(4, now & 0xffff);
  crypto.getRandomValues(bytes.subarray(6));
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f); // version 7
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Primary key: uuidv7 generated app-side (plan §7 "id (uuid v7)"). */
const pk = () => uuid("id").primaryKey().$defaultFn(() => uuidv7());
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// --- Identity/tenancy (plan §7) ---

export const users = pgTable("users", {
  id: pk(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  image: text("image"),
  emailVerified: boolean("email_verified").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: pk(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable("accounts", {
  id: pk(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verifications = pgTable("verifications", {
  id: pk(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizations = pgTable(
  "organizations",
  {
    id: pk(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("organizations_slug_idx").on(t.slug)],
);

export const memberships = pgTable(
  "memberships",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["admin", "annotator", "reviewer"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.orgId] }),
    index("memberships_org_idx").on(t.orgId),
  ],
);

export const invites = pgTable(
  "invites",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email"),
    role: text("role", { enum: ["admin", "annotator", "reviewer"] }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    maxUses: integer("max_uses").notNull().default(1),
    uses: integer("uses").notNull().default(0),
    invitedBy: text("invited_by"),
    createdAt: createdAt(),
  },
  (t) => [index("invites_org_idx").on(t.orgId)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    resource: text("resource"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_log_org_created_idx").on(t.orgId, t.createdAt),
    index("audit_log_actor_idx").on(t.actorId),
  ],
);

export const workerTokens = pgTable(
  "worker_tokens",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    scopes: text("scopes", { enum: ["jobs:read", "jobs:write", "admin"] })
      .notNull()
      .default("jobs:read"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("worker_tokens_org_idx").on(t.orgId)],
);

// --- Library ---

export const datasets = pgTable(
  "datasets",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    source: text("source", { enum: ["dentex", "tufts", "upload"] }).notNull(),
    licenseNote: text("license_note"),
    createdAt: createdAt(),
  },
  (t) => [index("datasets_org_idx").on(t.orgId)],
);

export const images = pgTable(
  "images",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => datasets.id, { onDelete: "cascade" }),
    sourceImageId: integer("source_image_id").notNull(),
    contentHash: text("content_hash").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    storageKey: text("storage_key").notNull(),
    split: text("split"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("images_dataset_source_uniq").on(t.datasetId, t.sourceImageId),
    index("images_org_idx").on(t.orgId),
    index("images_dataset_idx").on(t.datasetId),
  ],
);

export const imageVariants = pgTable(
  "image_variants",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    imageId: uuid("image_id")
      .notNull()
      .references(() => images.id, { onDelete: "cascade" }),
    variant: text("variant").notNull(),
    storageKey: text("storage_key").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("image_variants_uniq").on(t.imageId, t.variant),
    index("image_variants_org_idx").on(t.orgId),
  ],
);

// --- Annotations (LabelForge) ---

export const annotationSets = pgTable(
  "annotation_sets",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    imageId: uuid("image_id")
      .notNull()
      .references(() => images.id, { onDelete: "cascade" }),
    assigneeId: text("assignee_id"),
    state: text("state", { enum: ["draft", "submitted", "approved", "rejected"] })
      .notNull()
      .default("draft"),
    version: integer("version").notNull().default(1),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("annotation_sets_image_uniq").on(t.imageId),
    index("annotation_sets_org_idx").on(t.orgId),
  ],
);

export const annotations = pgTable(
  "annotations",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    imageId: uuid("image_id")
      .notNull()
      .references(() => images.id, { onDelete: "cascade" }),
    setId: uuid("set_id").references(() => annotationSets.id, { onDelete: "set null" }),
    bboxX: real("bbox_x").notNull(),
    bboxY: real("bbox_y").notNull(),
    bboxW: real("bbox_w").notNull(),
    bboxH: real("bbox_h").notNull(),
    fdiQuadrant: integer("fdi_quadrant").notNull(),
    fdiPosition: integer("fdi_position").notNull(),
    pathology: text("pathology").notNull(),
    source: text("source", { enum: ["gt_import", "model", "human"] }).notNull(),
    modelId: text("model_id"),
    confidence: real("confidence"),
    status: text("status", { enum: ["draft", "submitted", "approved", "rejected"] })
      .notNull()
      .default("draft"),
    version: integer("version").notNull().default(1),
    authorId: text("author_id"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("annotations_org_idx").on(t.orgId),
    index("annotations_image_idx").on(t.imageId),
    index("annotations_status_idx").on(t.orgId, t.status),
  ],
);

export const reviewTasks = pgTable(
  "review_tasks",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    imageId: uuid("image_id")
      .notNull()
      .references(() => images.id, { onDelete: "cascade" }),
    assigneeId: text("assignee_id"),
    state: text("state", { enum: ["open", "done", "skipped"] })
      .notNull()
      .default("open"),
    createdAt: createdAt(),
  },
  (t) => [index("review_tasks_org_state_idx").on(t.orgId, t.state)],
);

export const reviewDecisions = pgTable(
  "review_decisions",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    annotationId: uuid("annotation_id")
      .notNull()
      .references(() => annotations.id, { onDelete: "cascade" }),
    reviewerId: text("reviewer_id").notNull(),
    decision: text("decision", { enum: ["approve", "reject"] }).notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [index("review_decisions_org_idx").on(t.orgId)],
);

export const agreementStats = pgTable(
  "agreement_stats",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    imageId: uuid("image_id")
      .notNull()
      .references(() => images.id, { onDelete: "cascade" }),
    annotatorA: text("annotator_a").notNull(),
    annotatorB: text("annotator_b").notNull(),
    matched: integer("matched").notNull(),
    kappa: real("kappa"),
    pctAgree: real("pct_agree").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("agreement_stats_org_idx").on(t.orgId)],
);

export const predictions = pgTable(
  "predictions",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    imageId: uuid("image_id")
      .notNull()
      .references(() => images.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    boxes: jsonb("boxes").$type<unknown[]>().notNull(),
    meanConf: real("mean_conf"),
    minConf: real("min_conf"),
    entropy: real("entropy"),
    createdByJob: text("created_by_job"),
    createdAt: createdAt(),
  },
  (t) => [
    index("predictions_org_idx").on(t.orgId),
    index("predictions_image_idx").on(t.imageId),
  ],
);

export const queueScores = pgTable(
  "queue_scores",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    imageId: uuid("image_id")
      .notNull()
      .references(() => images.id, { onDelete: "cascade" }),
    strategy: text("strategy").notNull(),
    score: real("score").notNull(),
    computedBy: text("computed_by", { enum: ["worker", "heuristic"] })
      .notNull()
      .default("heuristic"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("queue_scores_uniq").on(t.imageId, t.strategy),
    index("queue_scores_org_idx").on(t.orgId),
  ],
);

export const datasetExports = pgTable(
  "dataset_exports",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    format: text("format", { enum: ["yolo", "coco"] }).notNull(),
    filter: jsonb("filter").$type<Record<string, unknown>>().notNull().default({}),
    storageKey: text("storage_key").notNull(),
    counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("dataset_exports_org_idx").on(t.orgId)],
);

// --- Traces (TraceLab) ---

export const traces = pgTable(
  "traces",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => datasets.id, { onDelete: "cascade" }),
    imageId: uuid("image_id")
      .notNull()
      .references(() => images.id, { onDelete: "cascade" }),
    cohort: text("cohort").notNull(),
    mode: text("mode", { enum: ["with_tools", "no_tools"] }).notNull(),
    verified: boolean("verified").notNull().default(false),
    sourceFile: text("source_file"),
    contentHash: text("content_hash").notNull(),
    nTurns: integer("n_turns").notNull().default(0),
    nToolCalls: integer("n_tool_calls").notNull().default(0),
    formatOk: boolean("format_ok").notNull().default(false),
    verifierReason: text("verifier_reason"),
    groundTruth: jsonb("ground_truth").$type<unknown>(),
    finalAnswer: jsonb("final_answer").$type<unknown>(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("traces_unique_uniq").on(t.datasetId, t.imageId, t.cohort, t.mode),
    uniqueIndex("traces_content_uniq").on(t.contentHash),
    index("traces_org_idx").on(t.orgId),
    index("traces_org_verified_idx").on(t.orgId, t.verified),
  ],
);

export const traceTurns = pgTable(
  "trace_turns",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    traceId: uuid("trace_id")
      .notNull()
      .references(() => traces.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    status: text("status").notNull(),
    thought: text("thought"),
    rawOutput: text("raw_output"),
    parsed: jsonb("parsed").$type<unknown>(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("trace_turns_uniq").on(t.traceId, t.idx),
    index("trace_turns_org_idx").on(t.orgId),
  ],
);

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => traceTurns.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    toolName: text("tool_name").notNull(),
    args: jsonb("args").$type<Record<string, unknown>>().notNull().default({}),
    ok: boolean("ok").notNull().default(false),
    error: text("error"),
    shownBbox: jsonb("shown_bbox").$type<unknown>(),
    trueBbox: jsonb("true_bbox").$type<unknown>(),
    perturbTier: text("perturb_tier"),
    result: jsonb("result").$type<unknown>(),
    artifactId: text("artifact_id"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("tool_calls_uniq").on(t.turnId, t.idx),
    index("tool_calls_org_idx").on(t.orgId),
  ],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["tool_image", "agent_image", "report", "model", "export"],
    }).notNull(),
    storageKey: text("storage_key").notNull(),
    mime: text("mime"),
    width: integer("width"),
    height: integer("height"),
    bytes: integer("bytes"),
    sha256: text("sha256"),
    provenance: text("provenance", {
      enum: ["worker_exact", "browser_approx", "import_replay"],
    }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("artifacts_org_idx").on(t.orgId)],
);

// --- Evaluation ---

export const evalRuns = pgTable(
  "eval_runs",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    dataset: text("dataset").notNull(),
    split: text("split").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    canonicalResize: boolean("canonical_resize").notNull().default(false),
    n: integer("n").notNull().default(0),
    sourceFile: text("source_file"),
    summary: jsonb("summary").$type<Record<string, number>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("eval_runs_org_idx").on(t.orgId)],
);

export const evalCases = pgTable(
  "eval_cases",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => evalRuns.id, { onDelete: "cascade" }),
    imageId: uuid("image_id"),
    groundTruth: jsonb("ground_truth").$type<unknown>(),
    predictionsJson: jsonb("predictions").$type<unknown>(),
    matchedPairs: jsonb("matched_pairs").$type<unknown>(),
    fdiF1: real("fdi_f1"),
    exactF1: real("exact_f1"),
    closeness: real("closeness"),
    confidence: real("confidence"),
    formatOk: boolean("format_ok"),
    rawOutput: text("raw_output"),
    createdAt: createdAt(),
  },
  (t) => [index("eval_cases_run_idx").on(t.runId), index("eval_cases_org_idx").on(t.orgId)],
);

export const modelRegistry = pgTable(
  "model_registry",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["yolo", "vlm", "api"] }).notNull(),
    stage: text("stage", { enum: ["zero_shot", "sft", "grpo", "yolo"] }).notNull(),
    hfPath: text("hf_path"),
    onnxArtifactId: text("onnx_artifact_id"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("model_registry_uniq").on(t.orgId, t.name, t.stage),
    index("model_registry_org_idx").on(t.orgId),
  ],
);

// --- Quality ---

export const qualityEvents = pgTable(
  "quality_events",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["verifier_reject", "directive_leak", "healthy_fp", "spatial_drift"],
    }).notNull(),
    traceId: uuid("trace_id").references(() => traces.id, { onDelete: "set null" }),
    cohort: text("cohort"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    source: text("source", { enum: ["scan", "import", "docs_seed"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("quality_events_org_kind_idx").on(t.orgId, t.kind),
    index("quality_events_trace_idx").on(t.traceId),
  ],
);

// --- Jobs/workers (plan §10) ---

export const workers = pgTable(
  "workers",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    runtime: text("runtime").notNull(),
    software: jsonb("software").$type<Record<string, unknown>>().notNull().default({}),
    capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
    status: text("status", { enum: ["online", "degraded", "offline"] })
      .notNull()
      .default("offline"),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("workers_org_idx").on(t.orgId)],
);

export const jobs = pgTable(
  "jobs",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    version: integer("version").notNull().default(1),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", {
      enum: ["queued", "claimed", "running", "succeeded", "failed", "cancelled", "expired"],
    })
      .notNull()
      .default("queued"),
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    idempotencyKey: text("idempotency_key"),
    result: jsonb("result").$type<unknown>(),
    error: jsonb("error").$type<unknown>(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("jobs_claim_idx").on(t.status, t.priority, t.createdAt),
    index("jobs_org_idx").on(t.orgId, t.status),
    // Atomic claim reaping + idempotent enqueue (plan §7/§10).
    uniqueIndex("jobs_idem_uniq").on(t.orgId, t.idempotencyKey),
  ],
);

export const jobEvents = pgTable(
  "job_events",
  {
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    data: jsonb("data").$type<unknown>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.jobId, t.seq] }),
    index("job_events_job_idx").on(t.jobId),
  ],
);

// --- Training ---

export const trainingRuns = pgTable(
  "training_runs",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["sft", "grpo", "yolo"] }).notNull(),
    name: text("name").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: ["queued", "running", "succeeded", "failed"] })
      .notNull()
      .default("queued"),
    createdAt: createdAt(),
  },
  (t) => [index("training_runs_org_idx").on(t.orgId)],
);

export const trainingMetrics = pgTable(
  "training_metrics",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => trainingRuns.id, { onDelete: "cascade" }),
    step: integer("step").notNull(),
    name: text("name").notNull(),
    value: real("value").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.step, t.name] }),
    index("training_metrics_run_idx").on(t.runId),
  ],
);

export const rewardSamples = pgTable(
  "reward_samples",
  {
    id: pk(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => trainingRuns.id, { onDelete: "cascade" }),
    step: integer("step").notNull(),
    trajectoryRef: text("trajectory_ref").notNull(),
    components: jsonb("components").$type<Record<string, number>>().notNull().default({}),
    total: real("total").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("reward_samples_run_idx").on(t.runId),
    index("reward_samples_org_idx").on(t.orgId),
  ],
);







