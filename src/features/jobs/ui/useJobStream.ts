"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createJobStream, IDLE_STREAM, type EventSourceLike, type JobStreamState } from "../lib/job-stream";

const noopSubscribe = () => () => {};

/** Live state of one job: SSE first, JSON polling if SSE keeps failing. */
export function useJobStream(jobId: string | null): JobStreamState {
  const stream = useMemo(() => {
    if (!jobId) return null;
    return createJobStream({
      url: (after, json) => `/api/jobs/${jobId}/events?after=${after}${json ? "&format=json" : ""}`,
      createEventSource: typeof EventSource === "undefined" ? undefined : (url) => new EventSource(url) as unknown as EventSourceLike,
      fetchFn: (url) => fetch(url, { headers: { accept: "application/json" }, cache: "no-store" }),
      setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
      clearTimeoutFn: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
  }, [jobId]);

  useEffect(() => {
    stream?.start();
    return () => stream?.stop();
  }, [stream]);

  return useSyncExternalStore(
    stream ? stream.subscribe : noopSubscribe,
    stream ? stream.getSnapshot : () => IDLE_STREAM,
    () => IDLE_STREAM,
  );
}
