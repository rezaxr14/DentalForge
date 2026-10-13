import { existsSync } from "node:fs";
import { join } from "node:path";

/** The specs boot `next start`; fail with an instruction instead of a 60 s server timeout. */
export default function globalSetup() {
  if (!existsSync(join(process.cwd(), ".next", "BUILD_ID"))) {
    throw new Error("No production build found. Run `pnpm build` before `pnpm e2e:browser`.");
  }
}
