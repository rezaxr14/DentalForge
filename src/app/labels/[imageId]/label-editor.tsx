"use client";

/**
 * M5 annotation editor — canvas-free box editor over the shipped JPEG.
 *
 * Coordinate rule (ADR-0005 §2): bboxes are stored in ORIGINAL dataset pixels;
 * the <img> is the downscaled variant. All pointer math converts through
 * rect-relative fractions so no variant-pixel state ever exists.
 *
 * Interactions: draw (drag on empty), move (drag box), resize (drag corner
 * handles), delete (key or button), FDI quadrant/position + pathology pickers,
 * GT overlay, pre-label import (replay tier), draft→submit workflow with
 * optimistic versioning via annotationStore.
 *
 * M9 (ADR-0018): every change goes through an event-sourced history (undo/redo,
 * one step per drag), FDI quick entry (digits), Alt+1..4 pathology, mirror,
 * Tab cycles boxes, odontogram and an accessible table view.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BoxTable } from "./box-table";
import { Odontogram } from "./odontogram";
import { SyncBadge, describeSync } from "./sync-badge";
import { useLabelSync } from "./use-label-sync";
import type { Annotation, AnnotationStatus, LabelFixture } from "@/shared/contracts/labels";
import { YoloPrelabelResult } from "@/shared/contracts/worker";
import {
  clampBox, agreementStats, predictionsToAnnotations, prelabelResultToAnnotations, type Bbox,
} from "@/shared/domain/annotation";
import { can } from "@/shared/domain/auth";
import { anatomicalName, fdiLabel, flipQuadrant } from "@/shared/domain/fdi";
import {
  feedDigit, history as H, initialEntry, mirrorAnnotation, nextIndex, pathologyForCode,
  type EditPatch, type EntryState,
} from "@/shared/domain/editing";
import {
  CapabilityGate, ProvenanceBadge, contextFor, resolveStrategy, useWorkerSnapshot,
} from "@/features/capability";
import { useJobStream } from "@/features/jobs";
import { isServerView, type LocalReason } from "@/shared/labels/sync-engine";
import {
  applyDecision, demoAuthorId, ensureSet, getRole, saveAnnotations, setRole,
} from "@/shared/lib/annotationStore";

const PATHOLOGIES = ["Caries", "Deep Caries", "Periapical Lesion", "Impacted"] as const;

const STATUS_TONE: Record<AnnotationStatus, string> = {
  draft: "border-zinc-300 dark:border-border bg-zinc-50 dark:bg-muted text-zinc-700 dark:text-zinc-300",
  submitted: "border-sky-300 bg-sky-50 text-sky-800",
  approved: "border-emerald-300 bg-emerald-50 text-emerald-800",
  rejected: "border-red-300 bg-red-50 text-red-800",
};

function sourceTone(source: Annotation["source"]): string {
  if (source === "gt_import") return "border-emerald-500";
  if (source === "model") return "border-sky-500";
  return "border-amber-500";
}

type Drag =
  | { kind: "draw"; startX: number; startY: number; x: number; y: number }
  | { kind: "move"; id: string; offX: number; offY: number }
  | { kind: "resize"; id: string; handle: "nw" | "ne" | "sw" | "se"; box: Bbox };

export function LabelEditor({ fixture }: { fixture: LabelFixture }) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [hist, setHist] = useState<H.History>(() => H.createHistory([]));
  const annotations = hist.present;
  // One id per pointer gesture: all moves of one drag coalesce into a single undo step.
  const gestureRef = useRef<string | null>(null);
  const gestureSeq = useRef(0);
  const entryRef = useRef<EntryState>(initialEntry);
  const [live, setLive] = useState("");
  // Local (browser-only) mode state. When the set is server-backed, version and status come from the sync engine (below).
  const [localVersion, setVersion] = useState(1);
  const [localStatus, setStatus] = useState<AnnotationStatus>("draft");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [preview, setPreview] = useState<Bbox | null>(null);
  const [showGt, setShowGt] = useState(false);
  const [showPreds, setShowPreds] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Local-mode demo role. The stored value is read after mount (in `hydrateLocal`), never during render: a returning
  // user's role differing from the server HTML is a hydration error (#418).
  const [role, setRoleState] = useState<"user" | "reviewer" | "admin">("user");
  const [reviewReason, setReviewReason] = useState("");
  // Worker tier of the "Suggest boxes" ladder: a queued yolo.prelabel job.
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobProblem, setJobProblem] = useState<string | null>(null);
  const [appliedJobId, setAppliedJobId] = useState<string | null>(null);

  // Capability ladder (plan §9.2): worker (`yolo.prelabel`) → stored
  // predictions (replay) → disabled with reason (+ queue for later when
  // queueable). Before the snapshot loads we resolve offline-conservatively —
  // never claiming a worker we have not seen.
  const snap = useWorkerSnapshot();
  const hasPredictions = (fixture.predictions?.length ?? 0) > 0;
  const capCtx = useMemo(
    () =>
      snap
        ? contextFor("yolo.prelabel", snap, { hasReplay: hasPredictions })
        : { hasReplay: hasPredictions, dbAvailable: false },
    [snap, hasPredictions],
  );
  const capability = useMemo(() => resolveStrategy("yolo.prelabel", capCtx), [capCtx]);
  const stream = useJobStream(jobId);

  // The image is saved to the server when a session with an active organization exists, otherwise to this browser (ADR-0020).
  // Never both: the sync engine decides once at load, and again only if the session ends.
  const hydrateLocal = (reason: LocalReason, present: readonly Annotation[]): void => {
    setRoleState(getRole());
    const set = ensureSet(fixture.id, fixture.gt.length);
    if (reason === "session-lost") {
      // Signed out mid-edit: what is on screen is newer than the local copy, so it is the one to keep.
      const res = saveAnnotations(fixture.id, [...present], set.version);
      if (res.ok) {
        setVersion(res.value.version);
        setStatus(res.value.state);
      } else {
        setVersion(set.version);
        setStatus(set.state);
        setMsg(`Could not keep your edits in this browser (${res.code}): ${res.reason}`);
      }
      return;
    }
    // Boxes drawn while the mode was still being decided are kept: added to the local set unless it is no longer a draft.
    const early = present.filter((a) => !set.annotations.some((x) => x.id === a.id));
    if (early.length > 0 && set.state !== "draft") setMsg("Boxes drawn while connecting were not kept: this set is no longer a draft.");
    setHist((h) => H.reset(h, set.state === "draft" ? [...set.annotations, ...early] : set.annotations));
    setVersion(set.version);
    setStatus(set.state);
  };
  const { view, engineRef } = useLabelSync({
    imageId: fixture.id,
    present: annotations,
    onRemote: (a) => {
      setHist((h) => H.reset(h, a));
      setSelectedId((cur) => (cur && a.some((x) => x.id === cur) ? cur : null));
      entryRef.current = initialEntry;
    },
    onLocalFallback: hydrateLocal,
  });
  const sv = isServerView(view) ? view : null;
  const connecting = view === null || view.mode === "connecting";
  const status: AnnotationStatus = sv ? sv.state : localStatus;
  const version = sv ? sv.version : localVersion;
  const uiRole: "user" | "reviewer" | "admin" = sv ? (sv.viewer.role === "annotator" ? "user" : sv.viewer.role) : role;
  const authorId = sv ? sv.viewer.userId : demoAuthorId;
  /**
   * The one gate for every way of changing boxes: pointer, keyboard, buttons, table, imports. Not closed while connecting:
   * a slow or unreachable database would otherwise leave the editor dead for seconds (those boxes are merged in when the
   * mode is decided). Saving and submitting do wait for the decision, so the two stores are never mixed.
   */
  const canEdit = status === "draft" && (sv ? sv.status !== "readonly" && can(sv.viewer.role, "annotation.edit") : true);
  const sync = describeSync(view);

  const selected = useMemo(
    () => annotations.find((a) => a.id === selectedId) ?? null,
    [annotations, selectedId],
  );

  /** Client px (relative to <img> box) → ORIGINAL dataset px. */
  const toOriginal = useCallback(
    (clientX: number, clientY: number): [number, number] => {
      const el = imgRef.current;
      if (!el) return [0, 0];
      const r = el.getBoundingClientRect();
      const fx = (clientX - r.left) / r.width;
      const fy = (clientY - r.top) / r.height;
      return [fx * fixture.width, fy * fixture.height];
    },
    [fixture.width, fixture.height],
  );

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const [x, y] = toOriginal(e.clientX, e.clientY);
    const handle = target.dataset.handle;
    const boxId = target.dataset.boxId;
    if (!canEdit) {
      if (boxId) setSelectedId(boxId);
      return;
    }

    if (handle && selectedId && selected) {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      gestureRef.current = `g${++gestureSeq.current}`;
      setDrag({ kind: "resize", id: selectedId, handle: handle as "nw" | "ne" | "sw" | "se", box: [...selected.bbox] as Bbox });
      return;
    }
    if (boxId) {
      const box = annotations.find((a) => a.id === boxId);
      if (box) {
        setSelectedId(boxId);
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        gestureRef.current = `g${++gestureSeq.current}`;
        setDrag({ kind: "move", id: boxId, offX: x - box.bbox[0], offY: y - box.bbox[1] });
        return;
      }
    }
    // Empty space → start drawing.
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSelectedId(null);
    setDrag({ kind: "draw", startX: x, startY: y, x, y });
    setPreview([x, y, 0, 0]);
  };

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!drag) return;
    const [x, y] = toOriginal(e.clientX, e.clientY);
    if (drag.kind === "draw") {
      const box: Bbox = [
        Math.min(drag.startX, x),
        Math.min(drag.startY, y),
        Math.abs(x - drag.startX),
        Math.abs(y - drag.startY),
      ];
      setPreview(box);
      return;
    }
    if (drag.kind === "move") {
      const current = annotations.find((a) => a.id === drag.id);
      if (!current) return;
      const clamped = clampBox(
        [x - drag.offX, y - drag.offY, current.bbox[2], current.bbox[3]],
        fixture.width,
        fixture.height,
      );
      if (clamped) {
        const key = gestureRef.current ?? undefined;
        setHist((h) => H.update(h, drag.id, { bbox: clamped }, { coalesceKey: key }));
      }
      return;
    }
    // resize
    const [bx, by, bw, bh] = drag.box;
    let l = bx, t = by, r = bx + bw, b = by + bh;
    if (drag.handle.includes("w")) l = x;
    if (drag.handle.includes("e")) r = x;
    if (drag.handle.includes("n")) t = y;
    if (drag.handle.includes("s")) b = y;
    const next = clampBox(
      [Math.min(l, r), Math.min(t, b), Math.abs(r - l), Math.abs(b - t)],
      fixture.width,
      fixture.height,
    );
    if (next) {
      const key = gestureRef.current ?? undefined;
      setHist((h) => H.update(h, drag.id, { bbox: next }, { coalesceKey: key }));
    }
  };

  const onPointerUp = (): void => {
    if (drag?.kind === "draw" && preview) {
      const box = clampBox(preview, fixture.width, fixture.height);
      if (box) {
        const id = `ann_${Date.now().toString(36)}_${nextIndex(annotations)}`;
        const next: Annotation = {
          id,
          bbox: box,
          fdi_quadrant: 3,
          fdi_position: 6,
          pathology: "Caries",
          source: "human",
          confidence: null,
          status: "draft",
          version: 1,
          author_id: authorId,
        };
        setHist((h) => H.create(h, next));
        setSelectedId(id);
        setMsg(null);
      }
      setPreview(null);
    }
    gestureRef.current = null;
    setDrag(null);
  };

  const persist = useCallback(
    (nextStatus?: AnnotationStatus) => {
      const res = saveAnnotations(fixture.id, annotations, version, nextStatus);
      if (!res.ok) {
        setMsg(
          res.code === "conflict"
            ? `Conflict: ${res.reason}. Reload to fetch the latest version.`
            : `Save failed (${res.code}): ${res.reason}`,
        );
        return;
      }
      setVersion(res.value.version);
      setStatus(res.value.state);
      setMsg(nextStatus === "submitted" ? "Set submitted for review." : "Draft saved.");
    },
    [annotations, fixture.id, version],
  );

  const announce = useCallback((m: string) => setLive(m), []);

  const deleteById = useCallback(
    (id: string) => {
      if (!canEdit) return;
      setHist((h) => H.remove(h, id));
      setSelectedId((cur) => (cur === id ? null : cur));
      announce("Box deleted.");
    },
    [announce, canEdit],
  );
  const deleteSelected = useCallback(() => {
    if (selectedId) deleteById(selectedId);
  }, [selectedId, deleteById]);

  const patchBox = useCallback(
    (id: string, patch: EditPatch): void => {
      if (!canEdit) return;
      setHist((h) => H.update(h, id, patch));
      setMsg(null);
    },
    [canEdit],
  );
  const patchSelected = (patch: EditPatch): void => {
    if (selectedId) patchBox(selectedId, patch);
  };

  const undo = useCallback((): void => {
    if (!canEdit) return;
    const step = hist.past[hist.past.length - 1];
    if (!step) return;
    const next = H.undo(hist);
    setHist(next);
    setSelectedId((cur) => (cur && next.present.some((a) => a.id === cur) ? cur : null));
    announce(`Undid ${H.describe(step.command)}.`);
  }, [hist, announce, canEdit]);
  const redo = useCallback((): void => {
    if (!canEdit) return;
    const step = hist.future[0];
    if (!step) return;
    const next = H.redo(hist);
    setHist(next);
    setSelectedId((cur) => (cur && next.present.some((a) => a.id === cur) ? cur : null));
    announce(`Redid ${H.describe(step.command)}.`);
  }, [hist, announce, canEdit]);

  const mirrorSelected = useCallback((): void => {
    if (!canEdit) return;
    const src = annotations.find((a) => a.id === selectedId);
    if (!src) return;
    const m = mirrorAnnotation(
      src,
      { width: fixture.width, height: fixture.height },
      { id: `ann_${Date.now().toString(36)}_${nextIndex(annotations)}`, authorId },
    );
    if (!m) {
      setMsg("Cannot mirror this box: nothing usable is left inside the image.");
      return;
    }
    const taken = annotations.some((a) => a.fdi_quadrant === m.fdi_quadrant && a.fdi_position === m.fdi_position);
    setHist((h) => H.create(h, m));
    setSelectedId(m.id);
    const tooth = fdiLabel(m.fdi_quadrant, m.fdi_position);
    setMsg(taken ? `Mirrored to ${tooth}, which already has a box (see the odontogram).` : `Mirrored to ${tooth}. Adjust the box to the tooth.`);
    announce(`Mirrored to ${tooth}.`);
  }, [annotations, selectedId, fixture.width, fixture.height, announce, canEdit, authorId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && e.code === "KeyZ") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && e.code === "KeyY") {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedId) {
          e.preventDefault();
          deleteSelected();
        }
      }
      if (e.key === "Escape") {
        entryRef.current = initialEntry;
        setSelectedId(null);
      }
      if (!canEdit || mod || !selectedId) return;
      if (e.altKey) {
        const path = pathologyForCode(e.code);
        if (path) {
          e.preventDefault();
          patchBox(selectedId, { pathology: path });
          announce(`Pathology ${path}.`);
        }
        return;
      }
      if (/^[0-9]$/.test(e.key)) {
        const r = feedDigit(entryRef.current, e.key, Date.now());
        entryRef.current = r.state;
        if (!r.consumed) return;
        e.preventDefault();
        if (r.commit) {
          patchBox(selectedId, { fdi_quadrant: r.commit.quadrant, fdi_position: r.commit.position });
          announce(`Tooth ${fdiLabel(r.commit.quadrant, r.commit.position)}.`);
        } else {
          announce(r.state.quadrant ? `Quadrant ${r.state.quadrant}, now the position 1 to 8.` : "");
        }
        return;
      }
      if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        mirrorSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelected, selectedId, undo, redo, patchBox, mirrorSelected, announce, canEdit]);

  /** Tab / Shift+Tab inside the image area walks the boxes; at either end focus leaves normally (no keyboard trap). */
  const onRegionKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== "Tab" || e.target !== e.currentTarget) return;
    const at = annotations.findIndex((a) => a.id === selectedId);
    const next = e.shiftKey ? (at < 0 ? -1 : at - 1) : at + 1;
    const box = annotations[next];
    if (!box) return;
    e.preventDefault();
    setSelectedId(box.id);
    announce(`Box ${next + 1} of ${annotations.length}: ${fdiLabel(box.fdi_quadrant, box.fdi_position)}, ${box.pathology}.`);
  };

  const importPrelabels = (): void => {
    if (!canEdit || !fixture.predictions?.length) return;
    const added = predictionsToAnnotations(fixture.predictions, {
      imageId: fixture.id,
      width: fixture.width,
      height: fixture.height,
      modelId: fixture.prediction_model ?? "unknown",
      startIdx: nextIndex(annotations),
      ...(sv ? { authorId: sv.viewer.userId } : {}),
    });
    if (added.length === 0) return;
    setHist((h) => H.createMany(h, added, "Import pre-labels"));
    setMsg(`Imported pre-labels (provenance: import_replay); review them before submitting.`);
  };

  /** Worker tier: enqueue `yolo.prelabel` now, or "for later" (stays queued until a worker connects). */
  const suggestOnWorker = async (): Promise<void> => {
    setJobProblem(null);
    setJobId(null);
    try {
      const imageId = /^\d+$/.test(fixture.id) ? Number(fixture.id) : fixture.id;
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          type: "yolo.prelabel",
          payload: { imageId, modelId: fixture.prediction_model ?? "yolo_cv_best" },
        }),
      });
      const body = (await res.json()) as { id?: string; detail?: string; title?: string; code?: string };
      if (res.ok && body.id) {
        setJobId(body.id);
        setMsg(capability.strategy === "worker" ? "Queued yolo.prelabel for the connected worker…" : "Queued for later — it will run when a worker connects.");
      } else {
        setJobProblem(body.detail ?? body.title ?? `Enqueue failed (HTTP ${res.status})`);
      }
    } catch {
      setJobProblem("Network error — could not reach the server.");
    }
  };

  // Apply a successful worker result exactly once (worker_exact provenance).
  // Render-phase adjustment (react.dev "you might not need an effect"): the job
  // stream is the external input; when it crosses to `succeeded` we derive the
  // annotation update once, guarded by the last applied job id.
  const succeededJob =
    stream.job?.status === "succeeded" && stream.job.id !== appliedJobId ? stream.job : null;
  if (succeededJob) {
    setAppliedJobId(succeededJob.id);
    const parsed = YoloPrelabelResult.safeParse(succeededJob.result);
    if (!parsed.success) {
      setMsg("Worker finished but the result failed schema validation — nothing applied.");
    } else if (!canEdit) {
      setMsg("Worker finished, but this set can no longer be edited — suggestions were not applied.");
    } else {
      const added = prelabelResultToAnnotations(parsed.data.boxes, {
        imageId: fixture.id,
        width: fixture.width,
        height: fixture.height,
        modelId: parsed.data.modelId,
        startIdx: nextIndex(annotations),
        ...(sv ? { authorId: sv.viewer.userId } : {}),
      });
      setHist((h) => H.createMany(h, added, "Apply worker suggestions"));
      setMsg(`Worker suggested ${added.length} boxes (provenance: worker_exact); review them before submitting.`);
    }
  }

  /** Server-backed state changes: the engine saves what is pending first, then asks the server (ADR-0019 §6). */
  const transition = async (t: "submit" | "approve" | "reject" | "reopen", reason?: string): Promise<void> => {
    const engine = engineRef.current;
    if (!engine) return;
    const r = await engine.transition(t, reason?.trim() ? reason.trim() : undefined);
    switch (r.kind) {
      case "ok":
        setReviewReason("");
        setMsg({ submit: "Set submitted for review.", approve: "Set approved.", reject: "Set rejected.", reopen: "Set reopened for editing." }[t]);
        break;
      case "conflict":
        setMsg("Someone changed this set first; showing its current state.");
        break;
      case "forbidden":
      case "invalid":
        setMsg(r.message);
        break;
      case "unauthorized":
        setMsg("You were signed out, so the set could not change state.");
        break;
      case "notFound":
        setMsg("This image is not open on the server any more. Reload the page.");
        break;
      case "unavailable":
        setMsg(`The server did not answer (${r.message}). Try again.`);
        break;
    }
  };

  const review = (decision: "approved" | "rejected"): void => {
    const res = applyDecision(fixture.id, decision, reviewReason, role);
    if (!res.ok) {
      setMsg(`Review failed (${res.code}): ${res.reason}`);
      return;
    }
    setVersion(res.value.version);
    setStatus(res.value.state);
    setHist((h) => H.reset(h, res.value.annotations));
    setReviewReason("");
    setMsg(`Set ${decision}.`);
  };

  const agreement = useMemo(
    () => agreementStats(fixture.id, "human", "gt_import", annotations, fixture.gt),
    [annotations, fixture.gt, fixture.id],
  );

  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

  const overlayBox = (
    b: Bbox,
    cls: string,
    key: string,
    interactive: boolean,
    boxId?: string,
  ): React.ReactNode => (
    <div
      key={key}
      className={`absolute ${cls}`}
      style={{
        left: `${(b[0] / fixture.width) * 100}%`,
        top: `${(b[1] / fixture.height) * 100}%`,
        width: `${(b[2] / fixture.width) * 100}%`,
        height: `${(b[3] / fixture.height) * 100}%`,
      }}
      data-box-id={interactive ? boxId : undefined}
    >
      {interactive && boxId === selectedId && (
        <>
          {(["nw", "ne", "sw", "se"] as const).map((h) => (
            <span
              key={h}
              data-handle={h}
              className={`absolute h-2.5 w-2.5 rounded-sm border border-zinc-900 bg-white dark:bg-card ${
                h.includes("n") ? "-top-1.5" : "-bottom-1.5"
              } ${h.includes("w") ? "-left-1.5" : "-right-1.5"} cursor-pointer`}
            />
          ))}
        </>
      )}
    </div>
  );

  return (
    <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
      <section>
        {/* Toolbar */}
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded border px-2 py-1 font-medium ${STATUS_TONE[status]}`}>
            {status} · v{version}
          </span>
          <SyncBadge view={view} />
          <button
            type="button"
            onClick={undo}
            disabled={!canEdit || !H.canUndo(hist)}
            title="Undo (Ctrl/Cmd+Z)"
            className="rounded border border-zinc-300 dark:border-border bg-white dark:bg-card px-2 py-1 text-zinc-700 dark:text-zinc-300 disabled:opacity-40"
          >
            Undo
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={!canEdit || !H.canRedo(hist)}
            title="Redo (Ctrl/Cmd+Shift+Z)"
            className="rounded border border-zinc-300 dark:border-border bg-white dark:bg-card px-2 py-1 text-zinc-700 dark:text-zinc-300 disabled:opacity-40"
          >
            Redo
          </button>
          <button
            type="button"
            onClick={() => setShowGt((v) => !v)}
            className={`rounded border px-2 py-1 ${showGt ? "border-emerald-600 bg-emerald-50 text-emerald-800" : "border-zinc-300 dark:border-border bg-white dark:bg-card text-zinc-600"}`}
          >
            GT overlay ({fixture.gt.length})
          </button>
          <button
            type="button"
            onClick={() => setShowPreds((v) => !v)}
            className={`rounded border px-2 py-1 ${showPreds ? "border-sky-600 bg-sky-50 text-sky-800" : "border-zinc-300 dark:border-border bg-white dark:bg-card text-zinc-600"}`}
          >
            Pre-labels ({fixture.predictions?.length ?? 0})
          </button>
          <ProvenanceBadge resolution={capability} />
          <CapabilityGate
            feature="yolo.prelabel"
            context={capCtx}
            fallback={(r) => (
              <span className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled
                  title={r.reason}
                  className="rounded border border-zinc-300 dark:border-border bg-white dark:bg-card px-2 py-1 text-zinc-700 dark:text-zinc-300 opacity-40"
                  data-suggest="unavailable"
                >
                  Suggest boxes
                </button>
                {r.queueable && (
                  <button
                    type="button"
                    onClick={() => void suggestOnWorker()}
                    disabled={!canEdit}
                    title="Queue an exact run; it executes when a worker connects"
                    className="rounded border border-indigo-300 bg-indigo-50 px-2 py-1 text-indigo-800 disabled:opacity-40"
                    data-suggest="queue-later"
                  >
                    Queue for later
                  </button>
                )}
              </span>
            )}
          >
            {(r) => (
              <span className="flex items-center gap-1.5">
                {r.strategy === "worker" ? (
                  <button
                    type="button"
                    onClick={() => void suggestOnWorker()}
                    disabled={!canEdit}
                    title={r.reason}
                    className="rounded border border-emerald-500 bg-emerald-50 px-2 py-1 text-emerald-800 disabled:opacity-40"
                    data-suggest="worker"
                  >
                    Suggest boxes (worker)
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={importPrelabels}
                    disabled={!fixture.predictions?.length || !canEdit}
                    title={r.reason}
                    className="rounded border border-zinc-300 dark:border-border bg-white dark:bg-card px-2 py-1 text-zinc-700 dark:text-zinc-300 disabled:opacity-40"
                    data-suggest="replay"
                  >
                    Suggest boxes (stored)
                  </button>
                )}
                {r.strategy !== "worker" && r.queueable && (
                  <button
                    type="button"
                    onClick={() => void suggestOnWorker()}
                    disabled={!canEdit}
                    title="Queue an exact run; it executes when a worker connects"
                    className="rounded border border-indigo-300 bg-indigo-50 px-2 py-1 text-indigo-800 disabled:opacity-40"
                    data-suggest="queue-later"
                  >
                    Queue for later
                  </button>
                )}
              </span>
            )}
          </CapabilityGate>
          <span className="ml-auto rounded border border-zinc-300 dark:border-border bg-zinc-50 dark:bg-muted px-2 py-1 text-zinc-600">
            {annotations.length} boxes · drag to draw · ⌫ deletes · Esc deselects · digits set the tooth (4 6 = 46)
          </span>
        </div>
        {sync.detail && (
          <p className="mb-2 text-xs text-zinc-700 dark:text-zinc-300" data-sync-detail>
            {sync.detail}
          </p>
        )}
        <p className="mb-2 text-xs text-zinc-500" data-capability-reason>
          {capability.reason}
        </p>
        {jobId && (
          <p className="mb-2 text-xs text-zinc-600" aria-live="polite">
            Job <span className="font-mono">{jobId.slice(0, 8)}</span> — <strong>{stream.status}</strong>
            <span className="ms-1 text-zinc-400">via {stream.transport}</span>
            {stream.job?.status === "queued" && " · waiting for a worker"}
          </p>
        )}
        {jobProblem && (
          <p role="alert" className="mb-2 text-xs text-red-600">
            {jobProblem}
          </p>
        )}

        {/* Image + overlay */}
        <p id="editor-keys" className="sr-only">
          Tab and Shift+Tab move between boxes. With a box selected: two digits set the tooth, so 4 then 6 is tooth 46;
          Alt+1 to Alt+4 set the pathology; M mirrors the box to the opposite tooth; Delete removes it;
          Ctrl or Cmd+Z undoes. The same boxes are editable in the table below.
        </p>
        <p className="sr-only" role="status" aria-live="polite">{live}</p>
        <div
          role="group"
          aria-label="Radiograph annotation area"
          aria-describedby="editor-keys"
          tabIndex={0}
          onKeyDown={onRegionKeyDown}
          className="relative select-none rounded border border-zinc-300 dark:border-border bg-zinc-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imgRef}
            src={fixture.image_path}
            alt={`Radiograph ${fixture.id}`}
            className="block w-full cursor-crosshair"
            draggable={false}
          />
          {/* GT overlay (green, non-interactive) */}
          {showGt &&
            fixture.gt.map((g, i) =>
              overlayBox(g.bbox as Bbox, "border-2 border-dashed border-emerald-400", `gt_${i}`, false),
            )}
          {/* Pre-label overlay (sky, non-interactive) */}
          {showPreds &&
            (fixture.predictions ?? []).map((p, i) =>
              overlayBox(p.bbox as Bbox, "border border-sky-400/70", `pl_${i}`, false),
            )}
          {/* Human/model annotations (interactive) */}
          {annotations.map((a) =>
            overlayBox(
              a.bbox as Bbox,
              `border-2 ${sourceTone(a.source)} ${a.id === selectedId ? "bg-amber-300/20" : "bg-transparent"} cursor-move`,
              a.id,
              true,
              a.id,
            ),
          )}
          {/* Rubber-band preview */}
          {preview &&
            overlayBox(preview, "border-2 border-dashed border-amber-400 bg-amber-400/20", "preview", false)}
        </div>
        <Odontogram annotations={annotations} selectedId={selectedId} onSelect={setSelectedId} />
        <BoxTable
          annotations={annotations}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onPatch={patchBox}
          onDelete={deleteById}
          readOnly={!canEdit}
        />
      </section>

      {/* Sidebar */}
      <aside className="space-y-4 text-sm">
        {/* Selected annotation editors */}
        <section className="rounded border border-zinc-200 p-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Selected box
          </h2>
          {selected ? (
            <div className="mt-2 space-y-3">
              <div>
                <p className="text-xs text-zinc-600">FDI quadrant</p>
                <div className="mt-1 flex gap-1">
                  {[1, 2, 3, 4].map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => patchSelected({ fdi_quadrant: q })}
                      disabled={!canEdit}
                      className={`h-8 w-8 rounded border text-xs disabled:opacity-40 ${
                        selected.fdi_quadrant === q
                          ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                          : "border-zinc-300 dark:border-border bg-white dark:bg-card text-zinc-700 dark:text-zinc-300"
                      }`}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs text-zinc-600">Tooth position</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => patchSelected({ fdi_position: p })}
                      disabled={!canEdit}
                      className={`h-8 w-8 rounded border text-xs disabled:opacity-40 ${
                        selected.fdi_position === p
                          ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                          : "border-zinc-300 dark:border-border bg-white dark:bg-card text-zinc-700 dark:text-zinc-300"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs text-zinc-600">Pathology</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {PATHOLOGIES.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => patchSelected({ pathology: p })}
                      disabled={!canEdit}
                      className={`rounded border px-2 py-1 text-xs disabled:opacity-40 ${
                        selected.pathology === p
                          ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                          : "border-zinc-300 dark:border-border bg-white dark:bg-card text-zinc-700 dark:text-zinc-300"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-xs text-zinc-600">
                {fdiLabel(selected.fdi_quadrant, selected.fdi_position)} —{" "}
                {anatomicalName(selected.fdi_quadrant, selected.fdi_position)}
              </p>
              <div className="flex items-center justify-between gap-2 font-mono text-[11px] text-zinc-500">
                <span>[{selected.bbox.map((v) => Math.round(v)).join(", ")}]</span>
                <span>
                  {selected.source}
                  {selected.confidence != null ? ` ${selected.confidence.toFixed(2)}` : ""}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={mirrorSelected}
                  disabled={!canEdit}
                  title="Copy to the opposite tooth (M)"
                  className="w-full rounded border disabled:opacity-40 border-zinc-300 dark:border-border bg-white dark:bg-card py-1 text-xs text-zinc-700 dark:text-zinc-300"
                >
                  Mirror to {fdiLabel(flipQuadrant(selected.fdi_quadrant), selected.fdi_position)}
                </button>
                <button
                  type="button"
                  onClick={deleteSelected}
                  disabled={!canEdit}
                  className="w-full rounded border border-red-300 bg-red-50 py-1 text-xs text-red-700 hover:bg-red-100 disabled:opacity-40"
                >
                  Delete box
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-xs text-zinc-500">
              Drag on the image to draw a box; click a box to edit its FDI + pathology.
            </p>
          )}
        </section>

        {/* Workflow */}
        <section className="rounded border border-zinc-200 p-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">Workflow</h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => (sv ? void engineRef.current?.flushNow() : persist())}
              disabled={!canEdit || connecting}
              className="rounded border border-zinc-400 dark:border-border bg-white dark:bg-card px-2 py-1 text-xs disabled:opacity-40"
            >
              {sv ? "Save now" : "Save draft"}
            </button>
            <button
              type="button"
              onClick={() => (sv ? void transition("submit") : persist("submitted"))}
              disabled={!canEdit || connecting}
              className="rounded border border-sky-500 bg-sky-50 px-2 py-1 text-xs text-sky-800 disabled:opacity-40"
            >
              Submit for review
            </button>
            {sv && status === "rejected" && (
              <button
                type="button"
                onClick={() => void transition("reopen")}
                className="rounded border border-zinc-400 dark:border-border bg-white dark:bg-card px-2 py-1 text-xs"
              >
                Reopen for editing
              </button>
            )}
          </div>
          {sv ? (
            <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400" data-viewer>
              Signed in as <span className="font-mono">{sv.viewer.userId.slice(0, 8)}</span> · {sv.viewer.role}
              {sv.assigneeId && sv.assigneeId !== sv.viewer.userId ? " · assigned to someone else" : ""}
            </p>
          ) : (
            <label className="mt-3 block text-xs text-zinc-600">
              Role for this browser-only draft
              <select
                className="mt-1 w-full rounded border border-zinc-300 dark:border-border bg-white dark:bg-card px-2 py-1.5"
                value={role}
                onChange={(e) => {
                  const r = e.target.value as "user" | "reviewer" | "admin";
                  setRoleState(r);
                  setRole(r);
                }}
              >
                <option value="user">user (annotate)</option>
                <option value="reviewer">reviewer (review)</option>
                <option value="admin">admin</option>
              </select>
            </label>
          )}
          {status === "submitted" && (
            <div className="mt-2 space-y-1.5">
              <input
                type="text"
                value={reviewReason}
                onChange={(e) => setReviewReason(e.target.value)}
                placeholder="Reason (optional)"
                aria-label="Review reason"
                className="w-full rounded border border-zinc-300 dark:border-border px-2 py-1.5 text-xs"
              />
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => (sv ? void transition("approve", reviewReason) : review("approved"))}
                  disabled={uiRole === "user"}
                  title={uiRole === "user" ? (sv ? "Only reviewers and admins can decide" : "Switch role to reviewer") : undefined}
                  className="flex-1 rounded border border-emerald-500 bg-emerald-50 py-1 text-xs text-emerald-800 disabled:opacity-40"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => (sv ? void transition("reject", reviewReason) : review("rejected"))}
                  disabled={uiRole === "user"}
                  title={uiRole === "user" ? (sv ? "Only reviewers and admins can decide" : "Switch role to reviewer") : undefined}
                  className="flex-1 rounded border border-red-400 bg-red-50 py-1 text-xs text-red-700 disabled:opacity-40"
                >
                  Reject
                </button>
              </div>
            </div>
          )}
          {msg && <p className="mt-2 text-xs text-zinc-700 dark:text-zinc-300">{msg}</p>}
        </section>

        {/* Agreement vs GT */}
        <section className="rounded border border-zinc-200 p-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Agreement vs GT
            <span className="ml-1.5 rounded border border-amber-300 bg-amber-50 px-1 normal-case text-amber-700">
              browser_approx
            </span>
          </h2>
          <dl className="mt-2 space-y-1 text-xs">
            <div className="flex justify-between">
              <dt className="text-zinc-600">Matched (IoU≥0.5)</dt>
              <dd className="font-mono">
                {agreement.matched} / {agreement.units}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-600">Cohen&apos;s κ</dt>
              <dd className="font-mono">
                {agreement.kappa == null ? "n/a" : agreement.kappa.toFixed(3)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-600">% agree</dt>
              <dd className="font-mono">{pct(agreement.pct_agree)}</dd>
            </div>
          </dl>
          <p className="mt-2 text-[11px] leading-snug text-zinc-500">
            Greedy IoU matching vs the DENTEX consensus boxes; κ is null (shown n/a) when
            undefined — never fabricated (ADR-0005 §5).
          </p>
        </section>

        {/* JSON view */}
        <section className="rounded border border-zinc-200 p-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">Set JSON</h2>
          <pre
            // Scrolls once there are a few boxes, so keyboard users must be able to focus it (axe: scrollable-region-focusable).
            tabIndex={0}
            role="region"
            aria-label="Annotation set as JSON"
            className="mt-2 max-h-56 overflow-auto rounded bg-zinc-900 p-2 text-[11px] leading-relaxed text-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {JSON.stringify({ image_id: fixture.id, state: status, version, annotations }, null, 1)}
          </pre>
        </section>
      </aside>
    </div>
  );
}






