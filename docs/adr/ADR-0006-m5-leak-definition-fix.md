# ADR-0006: M5 R1 — directive-leak definition corrected (assistant-only)

**Status:** accepted
**Date:** 2026-10-07
**Supersedes:** ADR-0003's "Directive leak is 100% systemic" finding

## Context

M3's quality scanner counted every trace whose stored `messages` contained
the literal string `TEACHER DIRECTIVE` and reported ~100% "directive leak".
That string lives in the stored *user* message (`messages[1]`): it is the
frontier-teacher generation scaffold (prompt + ground-truth findings handed
to the teacher), not model output. VLM-DENTAL's own definition
(`scripts/patch_and_regenerate_traces.py::check_for_leaks`, 15
`LEAK_PATTERNS`) scans **assistant-role messages only** — and its audit
reports zero leaks on the current corpus.

## Verification (probed 2026-10-07 against real files, read-only)

- `messages[1]` (user) holds the scaffold in with-tools lines
  (`[Earlier tool result omitted…]` item + `TEACHER DIRECTIVE: … N
  finding(s): Q..T..:Diagnosis; …` item) and in no-tools lines (plain
  string `TEACHER DIRECTIVE: …`).
- `check_for_leaks` over all 12 verified files (5,454 rows): **0 leaks**;
  scaffold present in 5,454/5,454.
- `src/shared/domain/quality.ts` now ports all 15 patterns in order
  (`LEAK_PATTERNS`), exposes `scanAssistantLeaks` (assistant role only,
  first hit per message), `scanThoughtLeaks` (assistant `parsed.thought`),
  and `hasTeacherScaffold` (non-assistant marker). The dashboard shows
  "Directive leaks (assistant text): 0" plus "Teacher scaffold: 5,454
  (expected)".

## R2 finding (SFT input path — confirmed contamination shape, fix lives in VLM-DENTAL)

- `dental_agent/training/sft.py::__getitem__` (first-user branch) rebuilds
  the prompt from the *stored* user text and drops only `[Earlier tool
  result omitted…]` items. The `TEACHER DIRECTIVE … N finding(s): …` item
  passes through verbatim — including the ground-truth finding list — for
  both with-tools (list content) and no-tools (string content) lines.
- There is **no TEACHER-strip** anywhere in `sft.py` (verified by source
  search). So SFT trains on prompts containing the answer while inference
  will not have it: train/inference skew plus answer leakage into the
  prompt. The recommended fix (in VLM-DENTAL, not here): strip everything
  from `TEACHER DIRECTIVE` onward (or replace msg[1] with the clean
  instruction) and add a regression test asserting no finding list survives
  in the rebuilt prompt. TraceForge surfaces the outcome here: leak 0,
  scaffold 5,454 (expected), with this ADR as the record.

## Decision

Leak = assistant-text `LEAK_PATTERNS` match (messages + thoughts); scaffold
= separate expected-setup metric. ADR-0003's systemic-leak conclusion is
withdrawn; its row-vs-case dedupe note still stands.

## Addendum 2026-10-07: milestone numbering vs the full plan

The LabelForge editor/review/queue/export work already in the tree calls
itself "M5" (ADR-0005, `tests/m5-labels.test.ts`,
`scripts/generate_m5_labels.py`). The completed plan file (§13) assigns M5
to this correctness/hygiene pass and LabelForge core to M9 with review/queue/
export in M10. Renaming is pure churn with zero behavior change, so the M5
names stay; mapping: old-M5 editor core ≈ new-plan M9, old-M5 review/queue/
export ≈ new-plan M10 (minus Canvas2D engine, `useOptimistic`, virtualized
queue, server zip — those remain M9/M10 work).
