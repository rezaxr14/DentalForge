/**
 * M9 slice 2 part 3, layer 1 (ADR-0020): everything the editor can do must be something the server accepts.
 *
 * The real editing core (history, mirror, ids) is driven by a seeded random walk; at random points the editor's boxes are
 * diffed against the last acknowledged ones and the resulting ops are sent through JSON, `CommandSchema` and the server's
 * own `applyOpsToSet`. No DB: both stores call that same function (ADR-0019 §4); the handler suite covers the HTTP layer.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Annotation } from "@/shared/contracts/labels";
import { clampBox, type Bbox } from "@/shared/domain/annotation";
import { diffToCommands, history as H, mirrorAnnotation, nextIndex } from "@/shared/domain/editing";
import { applyOpsToSet, CommandSchema } from "@/shared/domain/editing/persist";
import type { Command } from "@/shared/domain/editing/history";
import { canonicalAnnotation } from "@/shared/db/annotation-map";

const W = 2744;
const H_ = 1316;
const ME = "alice";
const Ops = z.array(CommandSchema);

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const human = (id: string, bbox: Bbox, over: Partial<Annotation> = {}): Annotation => ({
  id, bbox, fdi_quadrant: 3, fdi_position: 6, pathology: "Caries", source: "human", confidence: null, status: "draft", version: 1, author_id: ME, ...over,
});
const canon = (l: readonly Annotation[]) => l.map(canonicalAnnotation);
const send = (acked: readonly Annotation[], ops: Command[]) => {
  const wire = Ops.parse(JSON.parse(JSON.stringify(ops)));
  return applyOpsToSet(acked, wire, { width: W, height: H_, actorId: ME, normalize: canonicalAnnotation });
};

/** One editing session on the real core: returns the history and a flush() that behaves like the sync engine will. */
function session(seed: number) {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  let h = H.createHistory([]);
  let acked: Annotation[] = [];
  let seq = 0;
  const randomBox = (): Bbox => clampBox([r() * (W - 200), r() * (H_ - 200), 20 + r() * 300.123456789, 20 + r() * 300.987654321] as Bbox, W, H_) as Bbox;

  const actions: Record<string, () => void> = {
    draw: () => { h = H.create(h, human(`ann_${(seq++).toString(36)}_${nextIndex(h.present)}`, randomBox())); },
    drag: () => {
      const a = h.present.length ? pick(h.present) : null;
      if (!a) return;
      const key = `g${seq++}`;
      for (let i = 0; i < 1 + Math.floor(r() * 5); i++) h = H.update(h, a.id, { bbox: randomBox() }, { coalesceKey: key });
    },
    quadrant: () => { const a = h.present.length ? pick(h.present) : null; if (a) h = H.update(h, a.id, { fdi_quadrant: 1 + Math.floor(r() * 4), fdi_position: 1 + Math.floor(r() * 8) }); },
    pathology: () => { const a = h.present.length ? pick(h.present) : null; if (a) h = H.update(h, a.id, { pathology: pick(["Caries", "Deep Caries", "Periapical Lesion", "Impacted"]) }); },
    remove: () => { const a = h.present.length ? pick(h.present) : null; if (a) h = H.remove(h, a.id); },
    undo: () => { h = H.undo(h); },
    redo: () => { h = H.redo(h); },
    mirror: () => {
      const a = h.present.length ? pick(h.present) : null;
      const m = a && mirrorAnnotation(a, { width: W, height: H_ }, { id: `ann_${(seq++).toString(36)}_${nextIndex(h.present)}`, authorId: ME });
      if (m) h = H.create(h, m);
    },
  };
  const names = Object.keys(actions);
  const step = () => actions[pick(names)]!();
  const flush = () => {
    const ops = diffToCommands(acked, h.present);
    const res = send(acked, ops);
    expect(res, JSON.stringify(res) + " " + JSON.stringify(ops).slice(0, 300)).toMatchObject({ ok: true });
    if (!res.ok) return ops;
    expect(res.annotations).toEqual(canon(h.present));
    acked = res.annotations;
    // The float32 trap: after an acknowledgement nothing is pending, so the engine goes idle instead of re-sending forever.
    expect(diffToCommands(acked, h.present)).toEqual([]);
    return ops;
  };
  return { step, flush, history: () => h, acked: () => acked };
}

describe("the editor's boxes always reach the server as ops it accepts", () => {
  it("random sessions on the real core: every flush is accepted, reproduces the editor's boxes and then goes idle", () => {
    let flushes = 0;
    let nonEmpty = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const s = session(seed);
      const r = rng(seed * 7919);
      for (let i = 0; i < 60; i++) {
        s.step();
        if (r() < 0.2) {
          flushes++;
          if (s.flush().length) nonEmpty++;
        }
      }
      s.flush();
    }
    // The walk must exercise the thing it claims to: a vacuous pass (all flushes empty) would prove nothing.
    expect(flushes).toBeGreaterThan(500);
    expect(nonEmpty).toBeGreaterThan(300);
  });

  it("the raw recorded commands and their inverses (undo/redo re-insertion included) pass CommandSchema too", () => {
    let checked = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const s = session(seed);
      for (let i = 0; i < 60; i++) s.step();
      const hist = s.history();
      for (const e of [...hist.past, ...hist.future]) {
        for (const c of [e.command, H.invert(e.command)]) {
          const parsed = CommandSchema.safeParse(JSON.parse(JSON.stringify(c)));
          expect(parsed.success, JSON.stringify(c)).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it("a freshly drawn float64 box is not re-sent once the server has canonicalised it", () => {
    const drawn = human("ann_1", [100.123456789, 200.987654321, 50.5555555, 60.4444444]);
    const stored = canon([drawn]);
    expect(stored[0]!.bbox).not.toEqual(drawn.bbox);
    expect(diffToCommands(stored, [drawn])).toEqual([]);
    expect(diffToCommands([], [drawn])).toHaveLength(1);
  });

  it("negative control: the old editor patch shape (status inside `after`) is refused by the server schema", () => {
    // Before ADR-0020 the editor and the table view sent `{ ...patch, status: "draft" }` for every label edit.
    let h = H.createHistory([human("a", [100, 100, 50, 60])]);
    h = H.update(h, "a", { pathology: "Impacted", status: "draft" } as never);
    const cmd = h.past[0]!.command;
    expect(cmd.type).toBe("setLabel");
    expect(CommandSchema.safeParse(JSON.parse(JSON.stringify(cmd))).success).toBe(false);
    // and with the current shape the same edit is accepted
    h = H.update(H.createHistory([human("a", [100, 100, 50, 60])]), "a", { pathology: "Impacted" });
    expect(CommandSchema.safeParse(JSON.parse(JSON.stringify(h.past[0]!.command))).success).toBe(true);
  });
});

describe("diffToCommands", () => {
  const a = human("a", [10, 10, 100, 100]);
  const b = human("b", [300, 10, 100, 100], { fdi_quadrant: 4 });
  const c = human("c", [500, 10, 100, 100], { fdi_quadrant: 2 });

  it("is empty for equal lists and ignores fields the editor never changes through ops", () => {
    expect(diffToCommands([a, b], [a, b])).toEqual([]);
    expect(diffToCommands([a], [{ ...a, status: "approved", version: 9, confidence: 0.5, source: "model", author_id: "bob" }])).toEqual([]);
  });

  it("orders deletes, updates, creates; uses setLabel for label-only patches and update when geometry changes", () => {
    const ops = diffToCommands(
      [a, b, c],
      [{ ...a, pathology: "Impacted" }, { ...c, bbox: [1, 2, 3, 4], fdi_position: 2 }, human("d", [5, 5, 20, 20])],
    );
    expect(ops.map((o) => o.type)).toEqual(["delete", "setLabel", "update", "create"]);
    expect(ops[0]).toMatchObject({ type: "delete", annotation: { id: "b" }, index: 1 });
    expect(ops[1]).toEqual({ type: "setLabel", id: "a", before: { pathology: "Caries" }, after: { pathology: "Impacted" } });
    expect(ops[2]).toEqual({ type: "update", id: "c", before: { bbox: [500, 10, 100, 100], fdi_position: 6 }, after: { bbox: [1, 2, 3, 4], fdi_position: 2 } });
    expect(ops[3]).toMatchObject({ type: "create", annotation: { id: "d" }, index: 2 });
  });
});

describe("rebase without an op log (ADR-0019 §8, ADR-0020)", () => {
  it("replaying my diff on the server's newer boxes keeps both sides' edits (last writer wins per field) and never resurrects", () => {
    const a = human("a", [10, 10, 100, 100]);
    const b = human("b", [300, 10, 100, 100]);
    const base = [a, b];
    // my unacknowledged edits: move a, relabel b, draw c
    const mine = [{ ...a, bbox: [20, 20, 100, 100] as Bbox }, { ...b, pathology: "Impacted" }, human("c", [600, 10, 50, 50])];
    const pending = diffToCommands(base, mine);
    // meanwhile the server moved on: someone else relabelled a, deleted b and drew d
    const server = [{ ...a, pathology: "Deep Caries" }, human("d", [900, 10, 50, 50], { author_id: "bob" })];

    const res = applyOpsToSet(server, pending, { width: W, height: H_, actorId: ME, normalize: canonicalAnnotation });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.annotations.map((x) => x.id)).toEqual(["a", "d", "c"]);
    expect(res.annotations[0]).toMatchObject({ bbox: [20, 20, 100, 100], pathology: "Deep Caries" }); // my geometry + their label
    expect(res.annotations.some((x) => x.id === "b")).toBe(false); // their delete wins over my label edit
  });
});
