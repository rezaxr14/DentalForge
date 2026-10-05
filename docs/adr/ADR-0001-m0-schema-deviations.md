# ADR-0001: Trace/eval schema deviations found in M0 validation

**Status:** accepted
**Date:** 2026-10-05
**Context:** Plan §4.3/§4.5 draft zod schemas were written without access to the
real JSONL files. M0 rule: "reality wins; update the zod schemas, not the data."

## Deviations (all verified by probing real files in read-only ../VLM-DENTAL)

1. **`Turn.status` is optional.** Single-turn no-tools traces
   (`train_cot_traces_no_tools.jsonl`: 1 turn per line, 200/200 sampled) have
   NO `status` key. Schema: `status: z.string().optional()`.
2. **`Turn.raw_output` / `Turn.parsed` are optional.** Tool-execution turns
   (`status=tool_executed`, 2247/2481 turns in a 200-line sample of
   `train_cot_traces.jsonl`) carry ONLY `{turn, tool_calls_this_turn, status}`.
   Only terminal turns (final_answer / rejected_final_answer /
   unparseable_retry / invalid_tool_format) carry `raw_output` + `parsed`.
3. **`ToolCallRecord` has no `tool_error` in practice.** 0 errors over 2663
   sampled calls; no extra keys beyond the 5 known ones. Kept as optional for
   forward-compat; `.passthrough()` retained.
4. **Top-level `tool_calls` is `int` OR `[]`.** With-tools files store an int
   total (e.g. 42); no-tools files store an empty list. Schema is a union.
5. **`Finding` gains optional `raw_diagnosis`.** Eval records carry both
   normalized `diagnosis` and `raw_diagnosis` (e.g. "Impacted" vs
   "Impacted Tooth"). Plan §4.2 mentions storing both; the §4.3 draft omitted it.
6. **`EvalCase.timestamp` is a unix-epoch float**, not an ISO string
   (e.g. `1788418771.41`). Schema is `z.union([z.string(), z.number()])`.

## Related findings (not schema, recorded for later milestones)

- **Directive leak (quality dashboard seed):** 10/10 sampled lines in hybrid,
  dentex, hybrid-no-tools AND tufts_all files contain `TEACHER DIRECTIVE`
  text in user messages (ground-truth findings handed to the teacher).
- **Dedupe confirmed:** hybrid files are exact unions
  (`hybrid == dentex + tufts`, `hybrid_no_tools == dentex_no_tools + tufts_no_tools`);
  every `(dataset, image_id)` appears in >1 file (1645/1645). Importer must
  dedupe by `(dataset, image_id, mode, cohort)` + content hash per plan §4.3.
- **Tufts taxonomy is wider than plan §4.2:** sampled `tufts_all` ground truth
  contains `Pericoronal Lesion` (23) and `Non-Odontogenic Lesion` (41) alongside
  `Periapical Lesion` and `Inter-Radicular Lesion`. The §4.2 Tufts list
  (Periapical, Non-Odontogenic, Pericoronal, Inter-Radicular) matches modulo the
  "Lesion" suffix — normalization port must handle this.
- **Eval acceptance reproduced:** mean exact_f1/fdi_f1 per file matches plan §4.5
  to 3 decimals (kimi-k3 0.222/0.321, gemini-3.5-flash 0.188/0.319,
  qwen3.5-9b 0.112/0.204 n=49, llama-11b 0.010/0.077).
- **YOLO protocol note:** `10_models_eval.csv` held-out benchmark shows
  map50 0.9477–0.9593 (DENTEX+Tufts fold 1: 0.9593), i.e. the "target-filtered
  held-out" protocol per plan §4.7 — distinct from raw `model.val()` numbers.
