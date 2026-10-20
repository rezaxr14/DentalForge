# ADR-0021 — M9 slice 3: the editor with 500 boxes

Date: 2026-10-19 · Status: **implemented and measured** · Builds on ADR-0018 (editing core) and ADR-0020 (server wiring).

## Context
The plan called for a canvas `EditorEngine` and a frame budget at 500 boxes. Nothing had been measured, and the editor had no zoom or pan. Before choosing an architecture the editor was measured as it was: the real production build, a real session, 500 boxes seeded through the API
(the server's own limit per set), driven by a real browser (`pnpm perf:editor`, `e2e/perf-editor.spec.ts`).

## What the measurements showed (500 boxes, before)
Per pointer move of a drag: **script 75 ms** (React re-rendering the whole editor), **layout 44 ms**; 15,272 DOM nodes (12k of them the box table: 500 rows × three selects); 5.5 s to load; 12.6 s of blocking in long animation frames during one session of the scenarios.
Causes, found with Chromium's script/layout counters, a layout trace and ablation rather than guessed:
1. Every pointer move called `setHist`: the whole component re-rendered (500 overlay boxes, 500 table rows, the odontogram, the agreement stats, the full JSON), and the sync engine diffed the whole set on every move.
2. The table: changing one cell made the browser lay out all 500 rows (38 ms per keypress).
3. The "Set JSON" panel: a `<pre>` with the text of all 500 boxes (thousands of lines); the deferred re-render of that text cost ~30 ms of layout per edit although only 9 of 1,419 layout objects were dirty (layout trace).
A hypothesis that did **not** hold: `contain: layout` on the image area did not change the keypress layout cost (694 vs 813 ms, noise). It was reverted, not kept.

## Decisions
1. **A drag gesture's geometry lives outside React state.** While a box is moved/resized or a box is drawn, its node's style is written directly (`applyBoxStyle`) and the rubber band is one persistent node; the result is committed to the history **once, on release** (still one undo step), which is also the only render and the only sync diff of the gesture.
2. **Memoised units**: `OverlayBox` (per annotation), `StaticBoxes` (ground truth and stored pre-labels), `BoxRow` (per table row), `Odontogram`. All callbacks passed to them are stable, so a selection or one edit renders the affected unit, not 500.
3. **Read-outs follow the boxes one render behind** (`useDeferredValue`): the agreement statistics and the JSON view are not part of the editing loop.
4. **The box table is windowed above 40 boxes**: fixed row height, spacer rows, `aria-rowcount` / `aria-rowindex` so assistive technology still gets the full size and each row's position, a sticky header, `table-layout: fixed`, and the selected box's row is scrolled into view when the selection comes from the image, the odontogram or the keyboard.
   Up to 40 boxes the table renders in full exactly as before.
5. **The JSON view shows the first 25 boxes** and says how many are not shown; "Copy full JSON" builds the whole document on click.
6. **No canvas now.** With the drag isolated, moving a box costs 0.6–0.8 ms of script and ~0.7 ms of layout at 500 boxes; a canvas would not make that measurably cheaper, and it would cost the box overlay's accessibility (focusable, named boxes) and hit-testing. It becomes worth building when zoom/pan with thousands of boxes exists
   (neither does today, and the server caps a set at 500). **Zoom and pan are not implemented**; that is a feature, not a performance fix, and is left open.

## Result (same harness, same machine, 500 boxes)
| | before | after |
|---|---|---|
| drag, script per pointer move | ~75 ms | ~0.7 ms |
| drag, layout per pointer move | ~44 ms | ~0.6 ms |
| keypress that edits a box, layout | ~38 ms | <1 ms |
| DOM nodes | 15,272 | ~1,220 |
| load (navigation → table ready) | 5.5 s | 1.2 s |
| long-animation-frame blocking time over the scenarios | 12.6 s | 0.27 s |
| main-thread task time during an 80-move drag | 35.7 s | 2.9 s |
| wall time, drag move → painted frame, p50 / p95 (headless **software** rendering, noisy) | 505 / 653 ms | 42 / 81 ms |

Wall times are not a frame rate: headless Chromium has no GPU and its idle floor alone varied between 25 and 146 ms across runs of the same build. The work counters are the comparable numbers.

## The budget (a CI gate: `e2e/labels-budget.spec.ts`)
With 500 boxes: script < 6 ms and layout < 5 ms per pointer move of a drag; script < 40 ms and layout < 10 ms per keypress that edits a box; fewer than 3,000 DOM nodes. The ceilings are 5–10× what the editor measures (0.6–0.8 / ~0.7 / ~10.5 / ~0.75 / ~1,400) and 10–70× below what it was; three runs of the unmodified editor were stable.
Each fix was reverted in turn and the gate failed for the right number: no windowing (keypress layout 12 ms), a React render per drag move (script 11.7 ms), the full JSON in the DOM (keypress layout 36 ms).
`pnpm perf:editor` (opt-in, not in `e2e:browser`) prints frame times, long animation frames and, with `E2E_PERF_PROFILE=1` / `E2E_PERF_TRACE=1`, a CPU profile / layout trace.

## Consequences
- During a drag the sidebar's coordinates, the table's x/y/w/h, the JSON and the agreement panel show the box as it was at the start and update on release (the box itself and the handles move live).
- The table of a large set scrolls inside a box (≈10 rows high) instead of growing the page.
- Not measured: a real GPU, a phone, Windows; the 500-box ceiling is the server's, not the editor's.
