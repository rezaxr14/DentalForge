# ADR-0020 — M9 slice 2, part 3: what the editor sends and receives

Date: 2026-10-17 · Status: **layers 1, 2, 3a and 3b implemented and tested (viewer identity, edit patches, snapshot diff, bounds slack, model-box authorship, restored foreign boxes, typed client, sync engine, editor wiring); the Review and Export pages still read the browser store (layer 3c)** · Refines ADR-0018 (edit history) and ADR-0019 §4 and §8.

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

### Built in layer 3a: client and sync engine (framework-free, no UI yet)
5. **The pending set is a diff, not a command queue** (replaces "pending-command queue" in the plan of record). History rewrites one entry on every pointer move of a drag; a queue would either send every move or re-implement the merge rules.
   `src/shared/labels/sync-engine.ts` computes `diffToCommands(acked, present, { authorId: viewer })` when a request is about to go out; one request in flight; debounce 800 ms with a 3 s max wait; chunks of 200 ops.
   - 409 version: adopt the server's boxes, `present = pending.reduce(apply, server)` (last writer wins per field; a box someone else deleted is not resurrected), hand the merged boxes to the editor, status `merged` until the next edit.
   - Set no longer a draft (whichever 409 reason announces it): adopt it, read-only, "your latest edits were not saved". The server compares versions before state, so a stale writer on a submitted set arrives as a *version* conflict; the first version of the engine rebased into a non-draft set and left the status stuck on "saving" (found by running it against the real handlers).
   - 503/429/network: edits stay in memory; retry after `Retry-After` or 1, 2, 4 … 30 s; the count resets after any success and after a retry that finds nothing left to send. Edits made while waiting do not add requests.
   - 401: mode `local` (reason `session-lost`); the editor must persist its boxes locally. A set is server-backed or local, never both.
   - 422: status `error`, no automatic retry; the next edit tries again. 5 consecutive conflicts or 20 rounds without convergence also end in `error` instead of looping.
   - `transition()` saves what is pending first and refuses while edits are unsaved; `flushOnExit()` sends with `keepalive`; `hasUnsaved()` is for a leave-page prompt.
   Mode is decided once at load (GET, 404 → open, 401 → local `signed-out`, 403 → local `forbidden`, 503/network → local `server-unavailable`).
   `src/shared/labels/client.ts` turns every answer into a typed result and checks bodies with `SetDtoSchema` (`dto.ts`); a handler test parses real server output with `.strict()` so the two cannot drift.
   Contract with the editor: `getPresent()` must return the newest boxes synchronously, including right after `onRemote` (a ref updated inside the callback).

### Built in layer 3b: the editor on the server
9. **Start is `GET /api/labels/status`, then `POST …/open`.** `status` always answers 200 (`{ available, reason }`): the editor asks on every load, and a 401 (signed out) or 503 (no database) would show up as a failed request in the console of every
   such visitor and break every strict-console browser spec. `open` is idempotent (the first opener becomes the assignee), so there is no GET/404 probe. A session without an active organization is "signed out" for this purpose
   (a fresh sign-in has none until the header's organization switcher sets it).
10. **One gate, `canEdit`**, in `label-editor.tsx`: the set is a draft, the sync engine is not read-only, the role may edit. It is deliberately **open while the mode is still being decided** (see 16). It guards pointer (selecting a box still works), keyboard, undo/redo, sidebar pickers, the box table (`readOnly`), imports and worker suggestions.
    Before this, only the buttons were disabled: on a submitted set the pointer and keyboard still edited.
11. **Where the numbers come from.** Server-backed: version, state and role come from the engine's view (`viewer.role` annotator → "user"); local: from the browser store as before, with the demo role read after mount (a render-time `localStorage` read is a hydration error for a returning user).
    New boxes, mirrors and imports are authored by the viewer (`authorId`). A visible badge says where the boxes live (`Saved to server`, `Unsaved changes`, `Saving…`, `Saved · merged with others' changes`, `Offline · will retry` with a countdown, `Not saved`, `Read-only · submitted`, `Saved in this browser only`) and a line under the toolbar says why.
12. **Leaving the page**: `beforeunload` prompts while edits are unsaved, `pagehide`/`visibilitychange` send them with `keepalive`.
13. Two layout bugs surfaced only with realistic signed-in state on a 390 px phone and are fixed here: the site header's right-hand group did not wrap (603 px wide), and the box table's `sr-only` cells are absolutely positioned inside a scroller that was not `relative`, so they escaped it and widened the whole page by 81 px.

### Built in layer 2 (was open in layer 1)
6. **Model boxes ("Suggest boxes") are authored by the viewer and name their model.** The authorship rule is unchanged: an exception for `yolo:` authors would let an admin create boxes that count as nobody's work and then decide the set,
   bypassing the self-review rule. `Annotation` gets an optional `model_id` (max 200, only on `source: "model"` boxes, immutable after creation because patches are strict), stored in the existing `annotations.model_id` column by both stores
   and returned only when set. `predictionsToAnnotations` / `prelabelResultToAnnotations` take `authorId` (the viewer, for boxes that go to the server) and always set `model_id`; without `authorId` the local-mode default `yolo:<model>` author stays.
7. **Restoring a box someone else drew** (undo of a deletion that was already flushed) is re-authored to the viewer by `diffToCommands(acked, present, { authorId })`: the restorer is drawing it again. Boxes already on the server are never touched.

### Open (layer 3c and later)
16. **The editor is never dead while it decides** (found when the full browser suite failed on a Windows machine, where the first status call is slow because the database probe takes seconds to give up on an unreachable port; measured here: about 1 s against a refused port and 3.1 s against a hanging one).
    The first version closed the gate until the decision and silently dropped everything drawn meanwhile. Now boxes drawn before the decision are kept and merged into whichever store wins: replayed on the server's set (re-authored to the viewer, then saved) or added to the local set;
    a set that is no longer a draft drops them with a message. Saving and submitting stay disabled until the decision, so the two stores are never mixed.
14. The Review and Export pages still read the browser store; they should read with `GET /api/labels/{image}` (which never writes and answers 404 until the image is opened) and say so. A returning user's browser-only draft is not offered for import after signing in.
15. Canvas `EditorEngine` and a measured frame budget (slice 3); the overlay is DOM today.

## Consequences
- 21 hand-made mutants over the viewer field, the diff and the bounds rule (layer 1) and 11 over `model_id`, the model-only rule, `authorId` and re-authoring (layer 2) were all killed; two layer-2 survivors were equivalent clauses (a `model_id` comparison for a field that cannot change, a `!==` guard before a no-op copy) and were deleted after the mutation harness itself was fixed (its first run reported every mutant as surviving: the exit code was lost in nested shell quoting).
- One existing expectation changed shape: the worker-result mapping test now also expects `model_id` (a field was added, nothing was loosened).
- The editing-core test that asserted status in patches changed; reviewers should read that diff.
- The editor now saves to the server when a session with an active organization exists; the Review and Export pages still read the browser store and the Review page still says "no auth exists yet" (layer 3c: read with GET, never write).
- The engine and client have 41 + 3 tests that run against the REAL handlers on both stores; 31 mutants over engine, client and schema were all killed (two survivors were test gaps and are closed).
- Not covered by any browser test: a reviewer deciding on someone else's set (the browser spec has one admin who drew the boxes, so it shows the self-review refusal only); a role that cannot edit (all roles can today).
- Known gap: a returning user who has a local draft of an image and then signs in sees the server's set; the local draft is not merged or offered for import.
