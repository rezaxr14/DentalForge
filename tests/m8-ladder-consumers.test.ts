/**
 * Features consuming the capability ladder (M8, task A): the pure mapping and
 * resolution helpers behind LabelForge "Suggest boxes", the Tool Lab badge and
 * the trace viewer's image-or-placeholder decision.
 */
import { describe, expect, it } from "vitest";
import {
  prelabelResultToAnnotations,
  predictionsToAnnotations,
} from "@/shared/domain/annotation";
import { IMAGE_OUTPUT_TOOLS, isImageOutputTool } from "@/shared/domain/toolImage";
import { emptySnapshot, loadWorkerSnapshot, resolveFeature } from "@/features/capability/service";
import { resolveStrategy } from "@/features/capability/ladder";
import { MemoryStore } from "@/shared/db/memory";

describe("LabelForge pre-label mappings (worker + replay tiers)", () => {
  const target = { imageId: "3", width: 1000, height: 500, modelId: "yolo_cv_best", startIdx: 7 };

  it("maps stored predictions to draft model annotations, clamped into the image", () => {
    const anns = predictionsToAnnotations(
      [
        { bbox: [10, 20, 30, 40], fdi_quadrant: 2, fdi_position: 7, confidence: 0.9 },
        // grazes the edge → clamped back inside; below min size → dropped
        { bbox: [990, 490, 40, 40], fdi_quadrant: 1, fdi_position: 1, confidence: 0.4 },
        { bbox: [0, 0, 2, 2], fdi_quadrant: 4, fdi_position: 8, confidence: 0.3 },
      ],
      target,
    );
    expect(anns).toHaveLength(2);
    expect(anns[0]).toMatchObject({
      id: "pred_3_7",
      source: "model",
      status: "draft",
      version: 1,
      author_id: "yolo:yolo_cv_best",
      confidence: 0.9,
      bbox: [10, 20, 30, 40],
      fdi_quadrant: 2,
      fdi_position: 7,
    });
    // Edge-grazing box is clamped to the image bounds.
    const clamped = anns[1]!;
    expect(clamped.bbox[0] + clamped.bbox[2]).toBeLessThanOrEqual(1000);
    expect(clamped.bbox[1] + clamped.bbox[3]).toBeLessThanOrEqual(500);
    // Ids never collide with the existing annotations (startIdx).
    expect(new Set(anns.map((a) => a.id)).size).toBe(anns.length);
  });

  it("maps a yolo.prelabel worker result to the same shape (worker_exact tier)", () => {
    const anns = prelabelResultToAnnotations(
      [{ bbox: [5, 5, 50, 50], conf: 0.87, fdiQuadrant: 1, fdiPosition: 4 }],
      target,
    );
    expect(anns).toEqual([
      {
        id: "pred_3_7",
        bbox: [5, 5, 50, 50],
        fdi_quadrant: 1,
        fdi_position: 4,
        pathology: "Caries",
        source: "model",
        confidence: 0.87,
        status: "draft",
        version: 1,
        author_id: "yolo:yolo_cv_best",
      },
    ]);
  });
});

describe("image-output tool classification (trace viewer ladder)", () => {
  it("matches plan §4.4: five tools return images, three return data", () => {
    expect([...IMAGE_OUTPUT_TOOLS].sort()).toEqual(
      ["contralateral_compare", "denoise", "enhance_contrast", "window_level", "zoom_crop"].sort(),
    );
    for (const t of IMAGE_OUTPUT_TOOLS) expect(isImageOutputTool(t)).toBe(true);
    for (const t of ["locate_tooth", "fdi_label", "nudge_crop", "unknown_tool"]) {
      expect(isImageOutputTool(t)).toBe(false);
    }
  });
});

describe("consumers resolve honestly with the worker off", () => {
  const off = emptySnapshot("off", true, "integration-off");

  it("Tool Lab: image tools run in the browser; locate_tooth falls to unavailable with a reason", () => {
    const zoom = resolveFeature("tool.execute", off, { toolName: "zoom_crop", hasReplay: false });
    expect(zoom.strategy).toBe("browser");
    expect(zoom.reason).toContain("browser approximate");

    const locate = resolveFeature("tool.execute", off, { toolName: "locate_tooth", hasReplay: false });
    expect(locate.strategy).toBe("unavailable");
    expect(locate.queueable).toBe(false); // WORKER_MODE=off cannot queue
    expect(locate.reason).toMatch(/WORKER_MODE=off/);
  });

  it("LabelForge: falls to stored predictions when the worker is off, and says why", () => {
    const withStored = resolveFeature("yolo.prelabel", off, { hasReplay: true });
    expect(withStored.strategy).toBe("replay");
    expect(withStored.queueable).toBe(false);

    const withoutStored = resolveFeature("yolo.prelabel", off, { hasReplay: false });
    expect(withoutStored.strategy).toBe("unavailable");
    expect(withoutStored.reason).toMatch(/WORKER_MODE=off/);
  });

  it("LabelForge: queueable only when the integration is on and a DB can hold the job", () => {
    const live = emptySnapshot("live", true, "signed-out"); // nobody signed in yet
    const queued = resolveFeature("yolo.prelabel", live, { hasReplay: false });
    expect(queued.strategy).toBe("unavailable");
    expect(queued.queueable).toBe(true); // “queue for later” is offered
    const noDb = resolveFeature("yolo.prelabel", emptySnapshot("live", false, "db-unavailable"), { hasReplay: false });
    expect(noDb.queueable).toBe(false);
  });

  it("before the snapshot loads, the conservative context never claims a worker or a queue", () => {
    // The client pages use this context while `/api/worker/status` is in flight.
    const pending = resolveStrategy("yolo.prelabel", { hasReplay: true, dbAvailable: false });
    expect(pending.workerStatus).toBe("offline");
    expect(pending.strategy).toBe("replay");
    expect(pending.queueable).toBe(false);
    const locatePending = resolveStrategy("tool.execute", { toolName: "locate_tooth", dbAvailable: false });
    expect(locatePending.strategy).toBe("unavailable");
  });

  it("trace.render_artifacts resolves unavailable offline, and to a worker when one declares it", async () => {
    const r = resolveFeature("trace.render_artifacts", off);
    expect(r.strategy).toBe("unavailable");

    // With a live worker that declares the job, the ladder routes to the worker rung.
    const store = new MemoryStore();
    const org = await store.createOrg({ slug: "trace-cap", name: "trace-cap" });
    const repos = store.scoped(org.id);
    await repos.registerWorker({ name: "gpu", runtime: "local-gpu", capabilities: ["trace.render_artifacts"] });
    const snap = await loadWorkerSnapshot(repos, "live", true);
    expect(resolveFeature("trace.render_artifacts", snap).strategy).toBe("worker");
  });
});
