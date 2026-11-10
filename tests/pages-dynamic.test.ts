/**
 * Pages that read per-request data must be dynamic.
 *
 * Regression: /training, /evals and the like call `resolveDataSource()` but, built without TRACEFORGE_DATASOURCE, Next
 * rendered them statically and froze the fixture (or empty) state into the HTML, so a seeded demo database was
 * invisible until the next build. Whether a page was live depended on the build-time environment.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const pages = walk("src/app").filter((p) => /[\\/](page|layout)\.tsx$/.test(p));

describe("pages that read the data source", () => {
  const readers = pages.filter((p) => readFileSync(p, "utf8").includes("resolveDataSource"));

  it("are found (the scan itself works)", () => {
    expect(readers.length).toBeGreaterThanOrEqual(7);
  });

  for (const page of readers) {
    it(`${page.replace(/\\/g, "/")} declares force-dynamic`, () => {
      expect(readFileSync(page, "utf8")).toMatch(/^export const dynamic = "force-dynamic";$/m);
    });
  }
});
