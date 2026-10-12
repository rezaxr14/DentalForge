/**
 * Incremental reader for an SSE `Response`, for tests.
 *
 * Exactly ONE `read()` is ever in flight: abandoning a pending read when a timeout wins a race lets the next
 * chunk be delivered to it and silently lost (this bit the first version of the bus tests).
 */
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SseReader {
  readonly text: string;
  readonly done: boolean;
  /** Resolve once the accumulated text satisfies `pred`; reject after `ms` or if the stream ends first. */
  until(pred: (t: string) => boolean, ms?: number): Promise<string>;
  cancel(): Promise<void>;
}

export function sseReader(res: Response): SseReader {
  const r = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let done = false;
  let inflight: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  return {
    get text() {
      return buf;
    },
    get done() {
      return done;
    },
    async until(pred, ms = 2000) {
      const deadline = Date.now() + ms;
      while (!pred(buf)) {
        if (done) throw new Error(`stream ended before the condition held:\n${buf}`);
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`timed out after ${ms}ms waiting for the condition; got:\n${buf}`);
        inflight ??= r.read();
        const chunk = await Promise.race([inflight, delay(left).then(() => "timeout" as const)]);
        if (chunk === "timeout") continue; // keep `inflight`: the next call awaits the SAME read
        inflight = null;
        if (chunk.done) done = true;
        else buf += dec.decode(chunk.value);
      }
      return buf;
    },
    cancel: () => r.cancel(),
  };
}

/** True if NOTHING new arrives within `ms` (the stream is parked). */
export async function stays(rd: SseReader, ms: number): Promise<boolean> {
  const before = rd.text.length;
  try {
    await rd.until((t) => t.length > before, ms);
    return false;
  } catch {
    return true;
  }
}
