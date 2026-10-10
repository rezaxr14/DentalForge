/**
 * The worker contract is documented by GENERATION, and these tests make drift
 * impossible: the committed docs must equal what the zod schemas produce, and
 * every worker route in the app must be documented (and vice versa).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { buildWorkerOpenApi } from "@/shared/contracts/openapi";
import { renderContractMarkdown } from "@/shared/contracts/render-docs";
import { JOB_DEFINITIONS } from "@/shared/contracts/jobs";

const root = process.cwd();
const V1 = join(root, "src", "app", "api", "worker", "v1");

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? routeFiles(p) : name === "route.ts" ? [p] : [];
  });
}

describe("worker contract docs", () => {
  const doc = buildWorkerOpenApi();

  it("committed docs match the generated output (run `pnpm contract:docs` to refresh)", () => {
    const json = readFileSync(join(root, "docs", "worker-openapi.json"), "utf8");
    const md = readFileSync(join(root, "docs", "worker-contract.md"), "utf8");
    expect(json).toBe(JSON.stringify(doc, null, 2) + "\n");
    expect(md).toBe(renderContractMarkdown(doc));
  });

  it("every worker route is documented, and every documented path has a route", () => {
    const fromFiles = routeFiles(V1)
      .map((f) => "/" + relative(V1, f).split(sep).slice(0, -1).join("/"))
      .filter((p) => p !== "/openapi.json") // the document itself
      .map((p) => p.replace(/\[(\w+)\]/g, "{$1}"))
      .sort();
    expect(Object.keys(doc.paths as object).sort()).toEqual(fromFiles);
  });

  it("every job type documents both a payload and a result schema", () => {
    const schemas = (doc.components as { schemas: Record<string, unknown> }).schemas;
    const types = doc["x-job-types"] as Record<string, { payload: { $ref: string }; result: { $ref: string } }>;
    expect(Object.keys(types).sort()).toEqual(Object.keys(JOB_DEFINITIONS).sort());
    for (const t of Object.values(types)) {
      expect(schemas[t.payload.$ref.split("/").pop()!]).toBeDefined();
      expect(schemas[t.result.$ref.split("/").pop()!]).toBeDefined();
    }
  });

  it("is a well-formed OpenAPI 3.1 document: every $ref resolves, no per-schema $schema noise", () => {
    expect(doc.openapi).toBe("3.1.0");
    const schemas = (doc.components as { schemas: Record<string, unknown> }).schemas;
    const text = JSON.stringify(doc);
    const refs = [...text.matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(10);
    for (const r of new Set(refs)) expect(schemas[r], `dangling $ref ${r}`).toBeDefined();
    expect(text).not.toContain("json-schema.org/draft");
  });
});
