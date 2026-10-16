/**
 * Server wiring for the label endpoints. A durable store is required: with the in-memory fallback the routes answer
 * 503 + Retry-After and the editor keeps its browser-local store (ADR-0019 decision 10) instead of pretending to save.
 */
import { isDegradedStore, selectOrgStore } from "@/shared/db";
import { getActor } from "@/shared/jobs/deps";
import { problem } from "@/shared/jobs/problem";
import type { LabelDeps } from "./handlers";

export async function resolveLabelDeps(): Promise<LabelDeps | Response> {
  let store;
  try {
    store = await selectOrgStore();
  } catch {
    return problem(503, "unavailable", "Labels are unavailable", "The database is unreachable; retry shortly.", {}, { "retry-after": "15" });
  }
  if (isDegradedStore(store)) {
    return problem(503, "unavailable", "Labels are unavailable", "The database is unreachable; retry shortly.", {}, { "retry-after": "15" });
  }
  return { store, actor: await getActor() };
}
