import { resolveLabelDeps } from "@/shared/labels/deps";
import { labelStatus } from "@/shared/labels/handlers";

export const dynamic = "force-dynamic";

/** Static segment: wins over `[image]`; fixture image ids are numeric, so "status" can never be an image. */
export async function GET() {
  return labelStatus(await resolveLabelDeps());
}
