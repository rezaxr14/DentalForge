# ADR-0019 — M9 slice 2: server persistence for annotation sets

Date: 2026-10-16 · Status: **repository layer and HTTP API implemented and tested; editor wiring proposed** (next patch) · Scope: second slice of M9 (plan §11.3 "Persistence"). Not canvas, not autosave tuning (slice 3).

## Context
Editing is browser-local: `annotationStore.ts` keeps whole sets in `localStorage` under a stand-in author (`demo_user`) and a demo role switcher (ADR-0005 §4).
Postgres already had `annotation_sets` (unique per image, `version`, `assignee_id`, `state`), `annotations`, `review_tasks` and `review_decisions`, and `can()` already
gates `annotation.*` / `review.decide` with the no-self-approval rule. What did not exist: any annotation API (`src/app/api` has auth, health, jobs, storage, worker),
any repository method beyond `listAnnotations` / `createAnnotation`, and any way to store the ids the editor uses (`annotations.id` is a UUID; editor ids look like
`pred_1_3`). `AnnotationRecord` also omitted `confidence` and `model_id`, which the table has, so persisting model boxes through it dropped the confidence.
Fixture images are `"1"`…`"5"` (strings) while `images.id` is a UUID.

## Decisions

### Built (this patch)
1. **Image identity.** A fixture id maps to a database image by `(dataset source, sourceImageId)`, the pair `images` is already unique on; `sourceImageId` is the number in the fixture's
   `source_file` (`train_673.png` → 673), which is how the importer names DENTEX files (`resolveImagePath` in `import/imageMeta.ts`). `openAnnotationSet` **registers the dataset and image lazily**
   (idempotent; a per-org advisory lock keeps two first opens from creating two datasets, which have no unique key), so a fresh org can label without `pnpm import:local`.
   An existing dataset of the source (the oldest) and an existing image row win over the registration input. Registering a row publishes nothing; the image-licensing gate (plan §12.4) is unchanged.
2. **Client ids are stored, UUIDs stay internal.** `annotations.client_id text not null` (unique per `(set_id, client_id)`) and `annotations.position` (editor order) — migration `0005`, which backfills
   `client_id` from `id` on existing rows (the generated `ADD COLUMN … NOT NULL` fails on a non-empty table). The repository speaks the editor's ids only. `AnnotationRecord` keeps `confidence` and `modelId`.
3. **Ops, not snapshots.** `applyAnnotationOps({ baseVersion, ops })` takes the history module's `Command`s (`create | delete | update | setLabel | batch`) and applies them with the editor's own tolerant `apply`
   (unknown ids and duplicate creates are no-ops, so a retried batch converges). Coordinates and confidence are canonicalised to float32 (the columns are `real`) before comparing, so a replay that differs only by
   rounding is a no-op and does not bump the version.
4. **Validation (pure, `domain/editing/persist.ts`, called by both stores).** At most 200 leaf ops per request and 500 boxes per set; batches nest at most 4 deep; a created box is a draft authored by the caller; every box has
   finite coordinates and a positive size; **only `human` boxes must lie inside the image**. Model predictions legitimately overhang the image edge (5 of the 32 stored predictions of fixture 1 do, by up to 56 px), so
   rejecting them would be the ADR-0014 bug again: tolerant for model output, strict for human ground truth. A patch may change only geometry and labels; `status`, `author_id`, `source` are not patchable.
5. **Atomic, version-gated writes.** One critical section per call. MemoryStore has no `await` between its checks and its writes; DrizzleOrgStore uses one transaction that locks the set row (`FOR UPDATE`) and then
   compares `baseVersion`, so concurrent batches queue instead of racing. A stale version or a non-draft set returns a conflict carrying the current snapshot and writes nothing; any invalid op rolls the whole batch back.
   The version moves by one per batch that changed something and per transition. The returned snapshot is re-read, not constructed.
6. **Collaborative drafts and a small state machine.** Any member with `annotation.edit` may write a draft set (the demo org shares images between visitors); the assignee is the first opener. Transitions:
   `submit` (draft → submitted), `approve` / `reject` (submitted → approved / rejected, `review.decide`), `reopen` (rejected → draft). The role and the self-review rule are checked **inside** the same critical section that
   reads the contributors: the author of record is the actor if they drew any box, otherwise the assignee, and `can()` refuses actor = author. Each transition sets every box's status and writes an `audit_log` row
   (`annotation_set.<transition>`, with the reason). `review_decisions` is per box and stays unused in this slice.
7. **One shared test suite.** `describeAnnotationRepo`-style: `tests/helpers/annotation-repo-suite.ts` runs the same 21 tests against MemoryStore and DrizzleOrgStore, including two orgs using the same image key and
   the same box ids, a model-based comparison with the editor's `apply` over a seeded random sequence, concurrent opens and concurrent batches, and the real fixture-1 predictions. Under `CI=1` a missing Postgres fails instead of skipping.

8. **HTTP API** (`src/shared/labels/handlers.ts`, thin routes under `src/app/api/labels/[image]/`, same shape as `/api/jobs`: route → `resolveLabelDeps()` → framework-free handler). The image id is the fixture id
   (`1`…`5`); dimensions and licence come from the fixture, never the request. `GET /api/labels/{image}` (read-only; 404 until opened), `POST …/open`, `POST …/ops` (`{ baseVersion, ops }`),
   `POST …/transition` (`{ transition: submit | approve | reject | reopen, baseVersion, reason? }`; one route instead of one per transition). Errors are problem+json: 401 signed out or no active organisation,
   403 role/self-review, 404 unknown image or not opened, 409 `{ code: "conflict", reason: "version" | "state", set }`, 413 over 256 KB, 415 not `application/json`, 422 invalid request or op, 503 + `Retry-After`
   when the store is the in-memory fallback or unreachable. Writes accept only `application/json`, so a cross-site form cannot reach a cookie-authenticated endpoint even if SameSite handling changes.
   The org and role come from the session's membership (`getActor`), never from the request. The DTO has no internal UUIDs and no org id.

### Proposed (next patch)
9. **Rebase without an op log** (client). On 409 the client takes the server snapshot and replays its unacknowledged commands over it with the tolerant `apply`; within a field the last writer wins.
10. **Degradation** (client). The API answers 401/503 in those cases; the editor then keeps `annotationStore.ts` and says so with a visible badge. A set is either server-backed or local, never both.
    With a durable store the demo role switcher is replaced by the signed-in role (needs the owner's confirmation; local mode keeps the switcher).

## Not in this slice
Canvas engine and the frame budget, autosave tuning, duplicate warnings beyond the odontogram, an op log and three-way merge, presence, importing an existing local draft, persisting "Suggest boxes" results, the `review_tasks` queue.

## Known limits
- Opening an image in the editor makes the opener its assignee, who then cannot decide that set; review screens must read with `getAnnotationSet`, which never writes.
- Lazily registered image rows carry the fixture's original dimensions; an image an import created keeps its own.
- `m6-repos.test.ts` repeats the memory suite's assertions by hand; the new shared suite is the pattern to move it to.
