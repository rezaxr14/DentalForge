/**
 * Boots the PRODUCTION build (`next start`) with an explicit environment, like
 * `scripts/smoke-degradation.mjs`. The child gets ONLY the variables passed
 * here (plus PATH/HOME), so a variable in the developer's shell can never turn
 * a "Redis off" run into a "Redis on" run.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";

const NEXT_BIN = join(process.cwd(), "node_modules", "next", "dist", "bin", "next");

export const DB_URL = process.env.E2E_DATABASE_URL ?? process.env.SMOKE_DATABASE_URL ?? "postgresql://traceforge:traceforge@localhost:5433/traceforge";
export const DEAD_DB = "postgresql://nobody:nobody@127.0.0.1:1/none";
export const SECRETS = {
  BETTER_AUTH_SECRET: "browser-e2e-secret-0123456789-abcdefghijkl",
  INVITE_SIGNING_SECRET: "browser-e2e-invite-secret-0123456789",
};

export interface RunningApp {
  base: string;
  log: () => string;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startApp(env: Record<string, string>): Promise<RunningApp> {
  const port = await freePort();
  // `localhost` (not 127.0.0.1): Better Auth validates the Origin header against BETTER_AUTH_URL.
  const base = `http://localhost:${port}`;
  const child: ChildProcess = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(port)], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production", ...env, BETTER_AUTH_URL: base },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (d) => (log += d));
  child.stderr?.on("data", (d) => (log += d));

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      break;
    } catch {
      if (child.exitCode !== null || Date.now() > deadline) {
        child.kill("SIGKILL");
        throw new Error(`server did not start:\n${log}`);
      }
      await sleep(400);
    }
  }
  return {
    base,
    log: () => log,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(250);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}
