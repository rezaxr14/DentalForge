import { getEnv } from "@/shared/config/env";
import { getStorageAdapter } from "@/shared/jobs/deps";
import { problem } from "@/shared/jobs/problem";
import { getObject, putObject } from "@/shared/storage/gateway";
import { isSafeKey } from "@/shared/storage/signing";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ key: string[] }> };

async function keyOf(ctx: Ctx): Promise<string | null> {
  const key = (await ctx.params).key.map(decodeURIComponent).join("/");
  return isSafeKey(key) ? key : null;
}

export async function PUT(req: Request, ctx: Ctx) {
  const key = await keyOf(ctx);
  if (!key) return problem(400, "invalid_request", "Invalid object key");
  return putObject(req, key, getStorageAdapter(), getEnv().BETTER_AUTH_SECRET);
}

export async function GET(req: Request, ctx: Ctx) {
  const key = await keyOf(ctx);
  if (!key) return problem(400, "invalid_request", "Invalid object key");
  return getObject(req, key, getStorageAdapter(), getEnv().BETTER_AUTH_SECRET);
}
