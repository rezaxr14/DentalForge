# ADR-0018 — M9 slice 1: an event-sourced editing core, keyboard model, odontogram and table view

Date: 2026-10-16 · Status: accepted · Scope: first slice of M9 (plan §11.3). Not the whole milestone (see "Not in this slice").

## Context
The editor (built ahead of schedule as M5, ADR-0005) kept annotations in a plain `useState` array: no undo, every pointer-move was a state
write, boxes were not reachable by keyboard, and there was no view of which teeth were covered. M9 asks for history, quick entry, an odontogram,
duplicate warnings and an accessible table view.

## Decisions
1. **A pure history module** (`src/shared/domain/editing/history.ts`): commands `create | delete | update | setLabel | batch`, each carrying
   its own before/after (and insert index), so undo and redo are exact without looking anywhere else and the stack can later be shipped to the
   server as ops. No React, no DOM, no clock, no randomness.
2. **Drag coalescing:** one pointer gesture has one `coalesceKey`; consecutive updates of the same box with the same key merge into one step.
   A gesture that ends where it began leaves no step. A redone step never merges into a later gesture. Undo is not tied to saving: saving does
   not clear history, and an undo after a save simply makes the draft differ from the saved version again.
3. **FDI quick entry vs pathology hotkeys.** §11.3 binds both "type two digits (4 6 → tooth 46)" and "pathology hotkeys (1–4)" to the digit keys.
   They cannot both own them. **Plain digits are FDI entry; pathology is Alt+1..4**, matched by physical key (`event.code`) so layouts and
   Alt-composed characters do not matter. The first digit must be a quadrant (1–4), the second a position (1–8); a pending quadrant expires
   after 1.5 s. This changes the plan's wording; the plan's intent (both are one keystroke pair away) is kept.
3b. **Other keys:** Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y redo, M mirror, Delete remove, Esc deselect.
4. **Mirror** reflects the box across the image's vertical midline and flips the quadrant (1↔2, 3↔4), same position and pathology. It is a
   starting point, not a measurement: teeth are not symmetric about the image centre. The copy is a fresh human draft (source `human`, no
   confidence, version 1) whatever the source was. If the contralateral tooth already has a box the copy is still made and the odontogram flags
   the conflict.
5. **Odontogram:** the 32 permanent teeth in chart order (patient's right on the viewer's left). A tooth with more than one box is a **conflict**.
   State is a mark plus text (● one box, ! several, · none), never colour alone. Clicking a conflicted tooth walks its boxes.
6. **Keyboard access:** the image area is one focus stop; Tab / Shift+Tab inside it walk the boxes and, past either end, focus leaves
   normally (no keyboard trap). The table view lists every box with quadrant, position and pathology as selects, so everything the canvas can do
   to labels works without a pointer. Edits from the table, canvas and keyboard share one history.
7. **Bug fixed on the way:** imported boxes were named `pred_<image>_<annotations.length + i>`; after any delete a re-import reused a suffix, and
   the old editor held two boxes with one id. `nextIndex` returns a suffix above every existing one. (A batch import would otherwise have
   skipped such a box silently.)
8. **Accessibility finding:** the "Set JSON" `<pre>` scrolls once a set has a few boxes and was not keyboard-focusable
   (axe `scrollable-region-focusable`). The existing axe sweep always ran with zero boxes and never saw it. It is now focusable and labelled, and the
   new editor spec audits the page with boxes and a conflict in both themes.

## Not in this slice (M9 is not done)
- Server persistence of edits (debounced op batches with `baseVersion`, 409 rebase). Persistence is still the browser-local `annotationStore`.
- The canvas `EditorEngine` and the performance budget (§11.3: pan/zoom, 500 boxes, frame budget). The overlay is still DOM.
- Duplicate warning on a *drawn or relabeled* box beyond the odontogram, and autosave.

## Verification
`tests/m9-editing-core.test.ts` (33 unit tests) was mutation-tested by hand: 39 mutants of the four modules, 37 killed (the first pass killed 34; the three gaps it exposed got tests). The two survivors cannot
change any output: `pathologyForCode` accepting `Digit5` (the label array has four entries, so it still returns null) and an out-of-range label
being stored under key -1 instead of skipped (no slot has that key). `e2e/labels-editor.spec.ts` (7 browser tests, real mouse and keyboard) was
mutation-tested at the wiring level: 5 mutants (drag not coalesced, Tab trapping focus, odontogram click not cycling, Alt+digit ignored, M ignored),
each killed by the test meant to catch it.
