/**
 * Where does real data disagree with a zod contract? (ADR-0014)
 *
 * `diagnoseLines` validates every line of a JSONL file against a schema and aggregates the failures by
 * normalized issue path (array indices collapsed to `[]`), so one run lists EVERY way the data differs instead
 * of the first failure per line. The report carries only types and numbers, never strings from the data
 * (model output and ground truth stay out of logs).
 */
import type { ZodType } from "zod";

export interface PathStat {
  /** e.g. `predictions.[].tooth_position` */
  path: string;
  code: string;
  message: string;
  /** Number of LINES with at least one issue at this path. */
  lines: number;
  /** Description of one offending value: `number 36`, `null`, `string(12)`, `array(3)`, `missing`. */
  example: string;
}

export interface Diagnosis {
  /** Non-blank lines. */
  total: number;
  valid: number;
  invalid: number;
  notJson: number;
  byPath: PathStat[];
}

const normalizePath = (path: readonly PropertyKey[]): string =>
  path.map((p) => (typeof p === "number" ? "[]" : String(p))).join(".") || "(root)";

function valueAt(root: unknown, path: readonly PropertyKey[]): { found: boolean; value?: unknown } {
  let cur: unknown = root;
  for (const key of path) {
    if (cur === null || typeof cur !== "object" || !(key in (cur as object))) return { found: false };
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return { found: true, value: cur };
}

export function describeValue(v: { found: boolean; value?: unknown }): string {
  if (!v.found) return "missing";
  const x = v.value;
  if (x === null) return "null";
  if (typeof x === "number" || typeof x === "boolean") return `${typeof x} ${String(x)}`;
  if (typeof x === "string") return `string(${x.length})`;
  if (Array.isArray(x)) return `array(${x.length})`;
  return typeof x;
}

export function diagnoseLines(schema: ZodType, lines: string[]): Diagnosis {
  let total = 0;
  let valid = 0;
  let notJson = 0;
  const stats = new Map<string, PathStat>();

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    total += 1;
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      notJson += 1;
      continue;
    }
    const r = schema.safeParse(json);
    if (r.success) {
      valid += 1;
      continue;
    }
    const seenOnThisLine = new Set<string>();
    for (const issue of r.error.issues) {
      const path = normalizePath(issue.path);
      const key = `${path}\u0000${issue.code}`;
      if (seenOnThisLine.has(key)) continue;
      seenOnThisLine.add(key);
      const existing = stats.get(key);
      if (existing) existing.lines += 1;
      else {
        stats.set(key, { path, code: issue.code, message: issue.message, lines: 1, example: describeValue(valueAt(json, issue.path)) });
      }
    }
  }
  return {
    total,
    valid,
    invalid: total - valid,
    notJson,
    byPath: [...stats.values()].sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path)),
  };
}
