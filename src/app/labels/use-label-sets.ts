"use client";

/**
 * Where the Review, Export and queue pages get their sets from (ADR-0020, layer 3c). One rule, same as the editor: with a
 * session and an active organization the sets are the server's (one read-only `GET /api/labels`); otherwise they are this
 * browser's drafts. Never both, and until the choice is made `getSet` answers null, which is what the server rendered, so
 * hydration is safe and a returning user's local drafts are only read after mount.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Annotation, AnnotationStatus } from "@/shared/contracts/labels";
import { createLabelClient, type LabelResult, type TransitionName } from "@/shared/labels/client";
import type { SetDto, Viewer } from "@/shared/labels/dto";
import type { LocalReason } from "@/shared/labels/sync-engine";
import { getSet as getLocalSet } from "@/shared/lib/annotationStore";

/** What the pages need of a set, whichever store it came from. */
export interface SetLike {
  image_id: string;
  state: AnnotationStatus;
  version: number;
  assignee_id: string;
  annotations: Annotation[];
}

export type SetsPhase = "loading" | "server" | "local";

interface Data {
  phase: SetsPhase;
  localReason: Extract<LocalReason, "signed-out" | "server-unavailable"> | null;
  viewer: Viewer | null;
  sets: Map<string, SetDto>;
}
const LOADING: Data = { phase: "loading", localReason: null, viewer: null, sets: new Map() };

export function useLabelSets() {
  const client = useMemo(() => createLabelClient(), []);
  const [data, setData] = useState<Data>(LOADING);
  const alive = useRef(true);

  /** Decide server or browser and read the server's sets. Pure of React state: callers apply the result. */
  const read = useCallback(async (): Promise<Data> => {
    const local = (reason: Data["localReason"]): Data => ({ phase: "local", localReason: reason, viewer: null, sets: new Map() });
    const st = await client.status();
    if (st.kind !== "available") return local(st.kind === "signed-out" ? "signed-out" : "server-unavailable");
    const r = await client.list();
    if (r.kind === "ok") {
      return { phase: "server", localReason: null, viewer: r.value.viewer, sets: new Map(r.value.sets.map((s) => [s.imageId, s.set])) };
    }
    return local(r.kind === "unauthorized" ? "signed-out" : "server-unavailable");
  }, [client]);
  const load = useCallback(async (): Promise<void> => {
    const d = await read();
    if (alive.current) setData(d);
  }, [read]);

  useEffect(() => {
    alive.current = true;
    void read().then((d) => {
      if (alive.current) setData(d);
    });
    return () => {
      alive.current = false;
    };
  }, [read]);

  const getSet = useCallback(
    (imageId: string): SetLike | null => {
      if (data.phase === "server") {
        const s = data.sets.get(imageId);
        return s ? { image_id: imageId, state: s.state, version: s.version, assignee_id: s.assigneeId ?? "unassigned", annotations: s.annotations } : null;
      }
      if (data.phase === "local") {
        const s = getLocalSet(imageId);
        return s ? { image_id: imageId, state: s.state, version: s.version, assignee_id: s.assignee_id, annotations: s.annotations as Annotation[] } : null;
      }
      return null;
    },
    [data],
  );

  /** A decision on the server; the list is re-read afterwards whatever the answer (a conflict means someone else got there first). */
  const transition = useCallback(
    async (imageId: string, t: TransitionName, reason?: string): Promise<LabelResult> => {
      const s = data.sets.get(imageId);
      if (!s) return { kind: "notFound" };
      const r = await client.transition(imageId, { transition: t, baseVersion: s.version, ...(reason?.trim() ? { reason: reason.trim() } : {}) });
      if (r.kind === "ok" || r.kind === "conflict") await load();
      return r;
    },
    [client, data, load],
  );

  return { phase: data.phase, localReason: data.localReason, viewer: data.viewer, getSet, transition };
}
