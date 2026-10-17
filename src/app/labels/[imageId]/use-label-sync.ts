"use client";

/**
 * Owns one sync engine for the editor (ADR-0020). All browser-only work (fetch, timers, window listeners) happens in
 * effects, so the server render and the hydrating render never differ: `view` is `null` until the engine reports.
 *
 * Contract with the engine: `getPresent()` must be right *synchronously*, also right after a remote change. `presentRef`
 * is therefore updated inside `onRemote` as well as after every render; a boxes array the server handed us
 * (`remoteRef`) is never echoed back as an edit.
 */
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Annotation } from "@/shared/contracts/labels";
import { createLabelClient } from "@/shared/labels/client";
import { createSyncEngine, type LocalReason, type RemoteReason, type SyncEngine, type SyncView } from "@/shared/labels/sync-engine";

export interface LabelSyncOptions {
  imageId: string;
  /** The editor's boxes (`history.present`). */
  present: readonly Annotation[];
  /** The server's boxes replace the editor's (load, merge after a conflict, state change). */
  onRemote: (annotations: Annotation[], why: RemoteReason) => void;
  /** The image cannot be saved to the server (at load, or the session ended later); `present` is what the editor holds. */
  onLocalFallback: (reason: LocalReason, present: readonly Annotation[]) => void;
}

export function useLabelSync(o: LabelSyncOptions): { view: SyncView | null; engineRef: MutableRefObject<SyncEngine | null> } {
  const [view, setView] = useState<SyncView | null>(null);
  const engineRef = useRef<SyncEngine | null>(null);
  const presentRef = useRef<readonly Annotation[]>(o.present);
  const remoteRef = useRef<readonly Annotation[] | null>(null);
  const callbacks = useRef({ onRemote: o.onRemote, onLocalFallback: o.onLocalFallback });

  useEffect(() => {
    callbacks.current = { onRemote: o.onRemote, onLocalFallback: o.onLocalFallback };
  });

  useEffect(() => {
    let reportedLocal = false;
    const engine = createSyncEngine({
      imageId: o.imageId,
      client: createLabelClient(),
      getPresent: () => presentRef.current,
      onRemote: (annotations, why) => {
        presentRef.current = annotations;
        remoteRef.current = annotations;
        callbacks.current.onRemote(annotations, why);
      },
      onView: (v) => {
        setView(v);
        if (v.mode === "local" && !reportedLocal) {
          reportedLocal = true;
          callbacks.current.onLocalFallback(v.localReason ?? "server-unavailable", presentRef.current);
        }
      },
    });
    engineRef.current = engine;
    void engine.start();

    const onHide = (): void => {
      if (document.visibilityState === "hidden") engine.flushOnExit();
    };
    const onPageHide = (): void => engine.flushOnExit();
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (engine.hasUnsaved()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      engine.stop();
      engineRef.current = null;
    };
  }, [o.imageId]);

  useEffect(() => {
    presentRef.current = o.present;
    if (o.present === remoteRef.current) return;
    engineRef.current?.notifyChange();
  }, [o.present]);

  return { view, engineRef };
}
