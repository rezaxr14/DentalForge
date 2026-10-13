import type { Page } from "@playwright/test";

/**
 * Collects everything a user would never want to see in a console: uncaught
 * exceptions, `console.error`, failed same-origin requests and 5xx responses.
 * Specs assert `problems()` is empty — nothing is filtered silently; a known,
 * accepted message must be added to `allow` in the spec that accepts it.
 */
export function watchPage(page: Page, base: string, allow: RegExp[] = []) {
  const found: string[] = [];
  const push = (kind: string, text: string) => {
    if (!allow.some((re) => re.test(text))) found.push(`${kind}: ${text}`);
  };
  page.on("pageerror", (e) => push("pageerror", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") push("console.error", `${m.text()} @ ${m.location().url}`);
  });
  page.on("requestfailed", async (r) => {
    if (!r.url().startsWith(base)) return;
    const error = r.failure()?.errorText ?? "";
    if (error === "net::ERR_ABORTED") {
      // 1. Next.js aborts its own in-flight <Link> prefetches (`?_rsc=`) when the page navigates or closes.
      if (r.url().includes("_rsc=")) return;
      // 2. A server action whose response headers already arrived with a success status and whose
      //    body stream the client then stopped reading (the result was delivered; the UI updated).
      //    A request that never got a response is still a failure.
      const res = await r.response().catch(() => null);
      if (res && res.status() < 400) return;
    }
    push("requestfailed", `${r.method()} ${r.url()} ${error}`);
  });
  page.on("response", (r) => {
    if (r.url().startsWith(base) && r.status() >= 500) push("5xx", `${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return { problems: () => [...found], reset: () => void (found.length = 0) };
}

export const ERROR_BOUNDARY = [/Application error/i, /Internal Server Error/i, /This page couldn.t load/i, /Something went wrong/i];
