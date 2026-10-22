# ADR-0023 — M9: the decision history of a set is readable (audit-log read endpoint)

Date: 2026-10-23 · Status: **implemented and tested** · Closes the gap stated in ADR-0020 item 19 · Builds on ADR-0019 (transitions write `audit_log`) and ADR-0020 (one source rule for the Review board).

## Context
`transitionAnnotationSet` has always written an `audit_log` row (`annotation_set.<transition>`, `resource` = the set id, `meta` = `{ imageId, sourceImageId, version, reason }`) in the same transaction as the decision. Nothing read it, so in server mode the Review board showed the current state ("approved") but not who decided, when, or why, while browser mode already listed its own decisions.

## Decisions
1. **A narrow repository read, not "list the audit log".** `ScopedRepos.listSetDecisions(key)` returns the decisions of ONE image's set, oldest first, `[]` when the image or set is unknown. The audit log also holds token and invite entries; those are not exposed. Both stores implement it, and the mapping lives once in `annotation-map.ts` (`decisionOf`/`decisionsOf`) so they cannot disagree on what counts as a decision: the action must be `annotation_set.` + one of the four transitions, the row must belong to THIS set (`resource`) and THIS org, and `meta.version` must be a positive integer (`transitionAnnotationSet` always writes it, so a row without it did not come from there and is skipped, not shown half-filled).
2. **Order is by the version each decision produced**, with the clock only breaking ties. Versions are strictly increasing per set; `created_at` is the transaction start and two stores or two clocks can disagree.
3. **`GET /api/labels/history`** (`listHistory`) returns `{ viewer, history: [{ imageId, decisions: [{ transition, actorId, at, version, reason }] }] }` for every image of the org that has at least one decision (images with none are absent, like unopened ones in `GET /api/labels`). One request for the whole board instead of one per image. Read-only, session + active organisation, any role may read (the same rule as the list of sets). `SetDto`-style contract: `HistoryDtoSchema` in `src/shared/labels/dto.ts`, parsed with `.strict()` in a handler test and by the browser client (`client.history()`, every failure mapped like the other calls).
   The route name is a static segment next to `[image]`, as `status` is, so an image id of `history` is not addressable (fixture ids are numbers).
4. **The history is requested only by the page that shows it.** `useLabelSets(true)` (Review) reads it after the list; Export and the queue do not. It is read only in server mode: a signed-out visitor makes no request for it (asserted in a browser). If the history cannot be read (503, malformed answer) the board keeps showing the sets, with a visible message; it never falls back to this browser's decisions, because that would mix the two stores (ADR-0020 item 18).
5. **UI.** One list per image, one row per decision: `time · who verb — reason`. "you" when the actor is the viewer, otherwise the first 8 characters of the user id (the same rendering as the "Signed in as" line; display names are not stored in the audit entry). Verbs are past tense (submitted, approved, rejected, reopened). The same list renders browser-mode decisions, whose own wording is unchanged. Reasons are free text up to 2000 characters and are visible to every member, so a row wraps at any character: a 560-character unbroken reason widened the page by 3,571 px on a 390 px phone before `[overflow-wrap:anywhere]` was added (found by a browser test written before the fix).

## Not done / consequences
- Actors are ids, not names; the audit entry stores the id only.
- Times are shown as UTC date-time without a zone label, as in browser mode.
- Only transitions are audited. Edits (`ops`) are not, so the history is "who decided", not "who changed which box".
- `listHistory` calls the repository once per fixture image, like `listSets`; fine for 5 fixtures, to be replaced by one query if the image list grows.
- Nothing here has been run against Neon/Vercel or on Windows; see the delivery notes.

## Evidence
- Shared repository suite (memory AND Postgres, `tests/helpers/annotation-repo-suite.ts`): 2 new tests (history content, order, and what is not a decision; order by version, not insertion) and the organisation-isolation test extended (a row another org wrote naming this org's set id is not this org's decision).
- `tests/m9-label-handlers.test.ts` (both stores): 401, empty, content and order, other orgs invisible, every role may read, strict schema, reading writes nothing.
- `tests/m9-label-client.test.ts`: URL, schema, every failure.
- `e2e/labels-review.spec.ts` (3 tests): a real reviewer rejects with a reason, the author reopens and resubmits, the reviewer approves; both users read the five entries in order with the right "you"; light and dark with axe; the history endpoint failing; signed-out visitors never ask; a long unbroken reason on a phone.
- Mutation testing: 22 unit-level mutants (mapping, ordering, both stores' org and set filters, handler guards, DTO) and 6 UI mutants (history never read, never "you", raw transition, failure flag, request when signed out, reason dropped), all killed; the overflow was shown by the test failing before the CSS fix.
