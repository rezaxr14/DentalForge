# ADR-0020 — M9 slice 2, part 3: what the editor sends and receives

Date: 2026-10-17 · Status: **layers 1 and 2 implemented and tested (viewer identity, edit patches, snapshot diff, bounds slack, model-box authorship, restored foreign boxes); sync engine and editor wiring decided below but NOT built** · Refines ADR-0018 (edit history) and ADR-0019 §4 and §8.

## Context
Before wiring the editor to `/api/labels`, every command the real editing core can produce was driven through the server's own `CommandSchema` and `applyOpsToSet`
(`tests/m9-editing-wire.test.ts`: a seeded random walk over draw, drag, label, delete, undo, redo, mirror; the handler suite then repeats a realistic session through the HTTP handlers on both stores).
Reading the code and running that walk found four things that would each have broken the first real save:

1. **Every label edit would have been answered 422.** `patchBox` in the editor and the three selects of the table view sent `{ ...patch, status: "draft" }`; the server's `after` patches are strict and refuse `status`.
2. **Boxes dragged to the right or bottom image edge were refused.** The editor clamps in float64 (`x + w === width`); the server validates the canonical float32 form, where `x` and `w` are rounded independently, so `x + w` can pass the edge by about 1e-3 px
   (e.g. 2437.265 + 306.7351 = 2744.0001 in a 2744 px image). 671 of 18,862 random edge-touching boxes failed. Boxes at the edge are normal here (impacted third molars).
3. **The DTO did not say who is asking.** The server refuses any `author_id` but the signed-in user's, and the editor offers different controls per role.
4. Imported model boxes (`author_id: "yolo:<model>"`) and the re-insertion of a box someone else drew (undo of a flushed delete) could not be created under the authorship rule: both would have been answered 422 (handler test, negative control).

## Decisions
### Built
1. **`SetDto.viewer = { userId, role }`** on every response that carries a set (GET, open, ops 200, transition 200 and the `set` inside a 409). Chosen over a second client-side session fetch because the
   identity must be the one that answered the same request (a role change or sign-out between two requests would otherwise leave the editor offering controls the server will refuse), and it costs two fields, no new endpoint and no org id on the wire.
2. **An edit never changes `status`.** `history.update()` takes `EditPatch` (bbox, FDI, pathology), so a stray `status` is a type error rather than a production 422. This supersedes ADR-0018's "editing an approved box re-drafts it":
   with a server-side state machine only a draft set accepts edits (409 `state` otherwise) and `reopen` already resets every box, so a per-box re-draft has no meaning left. The one unit test that encoded the old behaviour was rewritten to assert the new one.
3. **Human boxes may overhang the image by at most `BOUNDS_EPSILON_PX = 0.01` px** (a hundredth of a pixel, far above float32 rounding at these sizes and far below anything drawable). Visible overhangs are still refused; model boxes are still exempt (ADR-0019 §4).
4. **`diffToCommands(acked, present)`** (pure, `domain/editing/diff.ts`): the ops that turn the last acknowledged boxes into the editor's boxes (deletes, then `update`/`setLabel` patches of bbox/FDI/pathology only, then creates in editor order).
   Boxes are equal when their float32 values are, so an acknowledged box is never re-sent.

### Decided, not built (sync engine, next layer)
5. **The pending set is a diff, not a command queue** (this replaces "pending-command queue" in the plan of record). History rewrites one entry on every pointer move of a drag; a queue would either send every move or re-implement the merge rules.
   The engine computes `diffToCommands(acked, present)` when it is about to send, one request in flight, `baseVersion` = acknowledged version. On 409 it adopts the returned set as `acked` and sets `present = pending.reduce(apply, server)`:
   last writer wins per field, my edit of a box someone else deleted is a no-op and never resurrects it (tested in `m9-editing-wire.test.ts`, "rebase without an op log").

### Built in layer 2 (was open in layer 1)
6. **Model boxes ("Suggest boxes") are authored by the viewer and name their model.** The authorship rule is unchanged: an exception for `yolo:` authors would let an admin create boxes that count as nobody's work and then decide the set,
   bypassing the self-review rule. `Annotation` gets an optional `model_id` (max 200, only on `source: "model"` boxes, immutable after creation because patches are strict), stored in the existing `annotations.model_id` column by both stores
   and returned only when set. `predictionsToAnnotations` / `prelabelResultToAnnotations` take `authorId` (the viewer, for boxes that go to the server) and always set `model_id`; without `authorId` the local-mode default `yolo:<model>` author stays.
7. **Restoring a box someone else drew** (undo of a deletion that was already flushed) is re-authored to the viewer by `diffToCommands(acked, present, { authorId })`: the restorer is drawing it again. Boxes already on the server are never touched.

### Open
8. Not gated yet: pointer and keyboard edits are not disabled when the set is not a draft (only buttons are), so on a submitted set the editor lets the user change boxes that the server will refuse. To be fixed with the wiring.

## Consequences
- 21 hand-made mutants over the viewer field, the diff and the bounds rule (layer 1) and 11 over `model_id`, the model-only rule, `authorId` and re-authoring (layer 2) were all killed; two layer-2 survivors were equivalent clauses (a `model_id` comparison for a field that cannot change, a `!==` guard before a no-op copy) and were deleted after the mutation harness itself was fixed (its first run reported every mutant as surviving: the exit code was lost in nested shell quoting).
- One existing expectation changed shape: the worker-result mapping test now also expects `model_id` (a field was added, nothing was loosened).
- The editing-core test that asserted status in patches changed; reviewers should read that diff.
- Nothing in the editor calls the API yet; the app still saves to the browser.
