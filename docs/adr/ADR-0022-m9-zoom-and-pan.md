# ADR-0022 — M9 slice 3: zoom and pan of the radiograph

Date: 2026-10-20 · Status: **implemented and tested** · Builds on ADR-0021 (editor performance).

## Context
The 2744×1316 radiograph is awkward to annotate without zoom, and the editor had neither zoom nor pan.

## Decisions
1. **Layout zoom, not a scale transform.** The annotation area keeps the image's aspect ratio (`aspect-ratio`), the content node is sized to `s` times the area (`width/height: s·100%`) and moved with a translate. Boxes are percent-positioned, so a zoom step is one cheap layout and a pan is a translate only.
   A CSS `scale()` transform was built first and abandoned after two measured defects: (a) browsers clamp a computed border width to at least 1 CSS px, so a "2 px / zoom" counter-scaled border drew ~6 px thick at ×6; (b) Blink snaps box edges to whole **CSS** pixels before the scale is applied, so at ×3.4 box frames could be up to 3.4 screen pixels off and the four resize handles painted at different widths (found by enlarging a screenshot, confirmed by hit-testing and by toggling box-shadow). Counter-scaling cannot fix either; layout zoom makes borders, handles and edges real device pixels at every zoom.
2. **Pure geometry** (`domain/viewport.ts`, 10 unit tests including a randomised sweep that fails if it passes vacuously): the scale is clamped to [1, 16], the image always covers the area (no empty margin), `zoomAt` keeps the image point under the cursor fixed, `reveal` centres a box that is out of view, `oneToOneScale` is the dataset's own pixels (2744) per screen pixel (the page serves a lower-resolution copy, so 1:1 is interpolated).
3. **Imperative application** (`use-viewport.ts`): styles are written straight to the DOM node, so wheel ticks and pan moves cause no React render; only the "×N" label is state, at most one update per frame.
4. **Interactions**: Ctrl/Cmd + wheel (also a trackpad pinch) zooms at the cursor and a plain wheel still scrolls the page; `+` / `−` / Home zoom and fit; Shift + arrows pan by 80 px; pan by the hand tool (a toggle button), Space + drag, or the middle button; buttons Zoom out / Zoom in / Fit / 1:1 / Hand. The level is announced in the live region. Zoom and pan work on a read-only set.
5. **Selecting from the table, the odontogram, the Tab walk or a mirror reveals the box** even when it was already the selected one: the first version keyed the reveal on a change of selected id and did nothing when the user panned away and clicked the same row (found by the browser spec).
6. Pointer-to-image maths is unchanged (it already used the image's on-screen rectangle), so a box drawn while zoomed and panned is stored at the right dataset coordinates; this is asserted in a real browser.

## Evidence
`e2e/labels-zoom.spec.ts` (6 tests, stable over repeated runs): buttons/keys/announcement/1:1; Ctrl+wheel keeps the point under the cursor; a box drawn zoomed and panned is stored at the right pixels and the overlay stays aligned; every pan method pans instead of drawing and cannot leave the image; an off-screen box selected from the table comes into view, borders stay 2 px and all four handles 10×10 px at zoom; a read-only set zooms/pans and passes axe.
`e2e/labels-budget.spec.ts` now also gates the zoomed state at 500 boxes: a zoom step costs ~1.5–2.3 ms of layout and ~4–6 ms of script, a pan step ~0.35 ms of script and no layout, a drag at ×5 ~0.3–0.4 ms of script per move.

## Not done
- No touch pinch (two-pointer) gesture; Ctrl+wheel covers trackpad pinch.
- The zoom level is not remembered across visits; no minimap.
- At the largest scales the image is the served lower-resolution copy, so it is interpolated.
