import { z } from "zod";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EvalCase, UnverifiedTraceWrapper, VerifiedTrace } from "@/shared/contracts/traces";
import { LabelFixture } from "@/shared/contracts/labels";

const FIXTURES = join(process.cwd(), "fixtures");

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, rel), "utf-8"));
}

export interface TraceSummary {
  id: string;
  file: string;
  dataset: string;
  imageId: number;
  mode: "with_tools" | "no_tools";
  cohort: string;
  nTurns: number;
  nToolCalls: number;
  formatOk: boolean;
  nFindings: number;
  verified: boolean;
}

function traceFileMeta(file: string): Pick<TraceSummary, "mode" | "cohort" | "verified"> {
  const verified = !file.startsWith("unverified");
  const mode = file.includes("no_tools") ? "no_tools" : "with_tools";
  const cohort = file
    .replace(/^unverified_/, "")
    .replace(/^verified_/, "")
    .replace(/\.json$/, "");
  return { mode, cohort, verified };
}

function toolCallCount(trace: { tool_calls: number | unknown[]; turns: { tool_calls_this_turn?: unknown[] }[] }): number {
  if (typeof trace.tool_calls === "number") return trace.tool_calls;
  return trace.turns.reduce((n, t) => n + (t.tool_calls_this_turn?.length ?? 0), 0);
}

/** All committed trace fixtures, validated. Numbers computed from fixture data. */
export function listTraces(): TraceSummary[] {
  const files = readdirSync(join(FIXTURES, "traces")).filter((f) => f.endsWith(".json"));
  return files.map((file) => {
    const data = readJson(`traces/${file}`) as Record<string, unknown>;
    if (file.startsWith("unverified")) {
      const u = UnverifiedTraceWrapper.parse(data);
      const traj = u.trajectory as { n_turns?: number } | undefined;
      return {
        id: file.replace(/\.json$/, ""),
        file,
        dataset: "dentex",
        imageId: u.image_id,
        ...traceFileMeta(file),
        nTurns: typeof traj?.n_turns === "number" ? traj.n_turns : 0,
        nToolCalls: 0,
        formatOk: false,
        nFindings: u.ground_truth.length,
        verified: false,
      } satisfies TraceSummary;
    }
    const t = VerifiedTrace.parse(data);
    return {
      id: file.replace(/\.json$/, ""),
      file,
      dataset: t.dataset,
      imageId: t.image_id,
      ...traceFileMeta(file),
      nTurns: t.turns.length,
      nToolCalls: toolCallCount(t),
      formatOk: t.format_ok,
      nFindings: t.final_answer?.length ?? 0,
      verified: true,
    } satisfies TraceSummary;
  });
}

export function getTrace(id: string): unknown {
  const params = z.object({ id: z.string().regex(/^[a-z0-9_]+$/i) }).parse({ id });
  return readJson(`traces/${params.id}.json`);
}

export interface EvalSummary {
  id: string;
  file: string;
  model: string;
  provider: string;
  dataset: string;
  n: number;
  exactF1: number;
  fdiF1: number;
}

/**
 * Eval leaderboard rows. NOTE: fixture files hold ONE case each, so the
 * per-file mean is illustrative only — full-file means were verified in M0
 * against the real JSONL (see ADR-0001) and are reproduced here as
 * checked-in reference values with their case counts.
 */
const evalReference: Record<string, { n: number; exactF1: number; fdiF1: number }> = {
  kimi_k3: { n: 50, exactF1: 0.222, fdiF1: 0.321 },
  gemini_flash: { n: 50, exactF1: 0.188, fdiF1: 0.319 },
  qwen: { n: 49, exactF1: 0.112, fdiF1: 0.204 },
  llama11b: { n: 50, exactF1: 0.01, fdiF1: 0.077 },
};

export function listEvals(): EvalSummary[] {
  const files = readdirSync(join(FIXTURES, "evals")).filter((f) => f.endsWith(".json"));
  return files.map((file) => {
    const id = file.replace(/\.json$/, "");
    const c = EvalCase.parse(readJson(`evals/${file}`));
    const ref = evalReference[id];
    return {
      id,
      file,
      model: c.model,
      provider: c.provider,
      dataset: c.dataset,
      // Reference means over the FULL real file (verified in M0); the fixture
      // holds a single case, so we never present a 1-case mean as a result.
      n: ref?.n ?? 1,
      exactF1: ref?.exactF1 ?? c.exact_f1,
      fdiF1: ref?.fdiF1 ?? c.fdi_f1,
    } satisfies EvalSummary;
  });
}

export function getEval(id: string): unknown {
  const params = z.object({ id: z.string().regex(/^[a-z0-9_]+$/i) }).parse({ id });
  return readJson(`evals/${params.id}.json`);
}

export interface LabelSummary {
  id: string;
  image_path: string;
  width: number;
  height: number;
  source_file: string;
  license: string;
  gtCount: number;
  predCount: number;
  meanConf: number | null;
  predictionModel: string | null;
}

/** M5 label fixtures, validated against the LabelFixture contract. */
export function listLabels(): LabelSummary[] {
  const dir = join(FIXTURES, "labels");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((file) => {
      const f = LabelFixture.parse(readJson(`labels/${file}`));
      const confs = (f.predictions ?? []).map((p) => p.confidence);
      return {
        id: f.id,
        image_path: f.image_path,
        width: f.width,
        height: f.height,
        source_file: f.source_file,
        license: f.license,
        gtCount: f.gt.length,
        predCount: confs.length,
        meanConf: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
        predictionModel: f.prediction_model,
      } satisfies LabelSummary;
    })
    .sort((a, b) => Number(a.id) - Number(b.id));
}

export function getLabel(id: string): LabelFixture {
  const params = z.object({ id: z.string().regex(/^[a-z0-9_]+$/i) }).parse({ id });
  return LabelFixture.parse(readJson(`labels/${params.id}.json`));
}
