"""`eval.run`: evaluate a model over a split, streaming one case per image (WP3).

The handler is a loop around the *same* per-image path `agent.run` uses (`make_run_one`), so an
evaluation cannot drift from a live run: same cohort switch, same budgets, same backend.

Design points fixed in ADR-0025 (WP3 addendum §3):

  * **Per-case metrics come from VLM-DENTAL**, not from a second implementation here. The matcher is
    imported at call time; when the checkout or its numeric dependencies are missing the job fails
    *retryable* with that reason. It never falls back to an invented score.
  * **Chunks of at most 100 cases** (`MAX_EVAL_CASES_PER_REQUEST`). Image ids are unique, so a chunk
    cannot trip the server's duplicate-`image_id` rule, and one image is always exactly one case.
  * **Retries are safe without an Idempotency-Key**: cases upsert on (run, image_id), so re-posting a
    chunk overwrites. The run identity is the worker's `runKey`.
  * **A failed case is reported, not fatal**: it becomes a `log` event and is left out of the chunk, so
    `n` counts real evaluations. If no case succeeds, the job fails — an empty run must not look green.
  * **No ground truth, no case**: an image the app knows nothing about is skipped with a log, exactly
    like `agent.run` refuses to invent `[]` for it.
"""
from __future__ import annotations

import re
import time
from typing import Any, Callable, Iterable, Sequence

from worker_errors import NonRetryable

#: Matches `MAX_EVAL_CASES_PER_REQUEST` in src/shared/contracts/ingest.ts.
CHUNK_SIZE = 100
#: One page of `GET /images` (the endpoint's own maximum).
PAGE_SIZE = 500
#: Default images per run when the payload gives neither ids nor a limit. Small on purpose: the plan's
#: "more than 10 images needs the owner's yes" is an operator rule, and a silent 500-image run is a
#: surprise nobody wants on a laptop.
DEFAULT_LIMIT = 10
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


class EvaluationUnavailable(RuntimeError):
    """The scoring code is not importable here. Retryable: fixing the environment fixes the job."""

    retryable = True
    code = "evaluation_unavailable"


def load_matcher() -> Callable[[Sequence[dict[str, Any]], Sequence[dict[str, Any]]], dict[str, Any]]:
    """VLM-DENTAL's `match_multi_findings`, or a precise retryable failure."""
    try:
        from dental_agent.evaluation.metrics import match_multi_findings
    except ImportError as e:  # numpy/scipy/sklearn come from requirements-light.txt
        raise EvaluationUnavailable(f"VLM-DENTAL scoring is not importable: {e}") from e
    return match_multi_findings


def build_case(
    *,
    image_id: int,
    dataset: str,
    split: str,
    provider: str,
    model: str,
    ground_truth: list[dict[str, Any]],
    predictions: list[dict[str, Any]],
    format_ok: bool,
    raw_output: str,
    finish_reason: str,
    match: Callable[[Sequence[dict[str, Any]], Sequence[dict[str, Any]]], dict[str, Any]],
) -> dict[str, Any]:
    """One `EvalCase` row — the same fields `scripts/run_zero_shot.py` writes as a JSONL line.

    The clinical indicators mirror that script exactly (including the healthy-scan rule), so a case
    produced here is comparable with the tracked zero-shot files.
    """
    res = match(ground_truth, predictions)
    if len(ground_truth) == 0:
        correct_normal = bool(len(predictions) == 0 and format_ok)
        fdi_ok = exact_match = all_exact = correct_normal
    else:
        fdi_ok = bool(res["fdi_tp"] > 0)
        exact_match = bool(res["exact_tp"] > 0)
        all_exact = bool(res["exact_fn"] == 0 and res["exact_fp"] == 0)

    pairs = res.get("matched_pairs") or []
    primary = pairs[0]["pred"] if pairs else (predictions[0] if predictions else None)
    confidence = (
        primary.get("confidence")
        if primary
        else (1.0 if (len(ground_truth) == 0 and len(predictions) == 0) else None)
    )
    return {
        "image_id": image_id,
        "dataset": dataset,
        "split": split,
        "provider": provider,
        "model": model,
        "ground_truth": ground_truth,
        "predictions": predictions,
        "matched_pairs": pairs,
        "fdi_precision": res["fdi_precision"],
        "fdi_recall": res["fdi_recall"],
        "fdi_f1": res["fdi_f1"],
        "exact_precision": res["exact_precision"],
        "exact_recall": res["exact_recall"],
        "exact_f1": res["exact_f1"],
        "closeness_score": res["closeness_score"],
        "spatial_proximity": res["spatial_proximity"],
        "diagnostic_similarity": res["diagnostic_similarity"],
        "fdi_correct": fdi_ok,
        "quadrant_correct": fdi_ok,
        "tooth_position_correct": fdi_ok,
        "diagnosis_correct": exact_match,
        "exact_match": exact_match,
        "all_exact_match": all_exact,
        "final_answer": primary,
        "raw_output": raw_output,
        "format_ok": format_ok,
        "finish_reason": finish_reason,
        "confidence": confidence,
        "timestamp": time.time(),
    }


def _last_raw(outcome: Any) -> str:
    for turn in reversed(getattr(outcome, "turns", []) or []):
        raw = turn.get("raw_output") if isinstance(turn, dict) else None
        if isinstance(raw, str) and raw:
            return raw
    return ""


def _finish_reason(outcome: Any) -> str:
    for turn in reversed(getattr(outcome, "turns", []) or []):
        if not isinstance(turn, dict):
            continue
        status = turn.get("status") or turn.get("finish_reason")
        if isinstance(status, str) and status:
            return status
    return "stop"


def _resolve_image_ids(ctx: Any, payload: dict[str, Any]) -> list[str]:
    """App image UUIDs for the run: the payload's `imageIds`, or a page of the split."""
    ids = payload.get("imageIds")
    if ids:
        bad = [i for i in ids if not (isinstance(i, str) and UUID_RE.match(i))]
        if bad:
            raise NonRetryable(
                "payload.imageIds must contain TraceForge image UUIDs; got research-repo ids "
                f"{bad[:5]} which a worker cannot resolve to pixels"
            )
        return list(dict.fromkeys(ids))

    dataset_id = payload.get("datasetId")
    if not dataset_id:
        raise NonRetryable("payload.datasetId (or imageIds) is required to choose the images of a run")
    limit = int(payload.get("limit") or DEFAULT_LIMIT)
    split = payload.get("split")
    out: list[str] = []
    offset = 0
    while len(out) < limit:
        page = ctx.client.get(
            f"/images?datasetId={dataset_id}&split={split or ''}&limit={min(PAGE_SIZE, limit - len(out))}&offset={offset}"
        )
        images = page.get("images") or []
        out.extend(i["id"] for i in images)
        offset += len(images)
        if not images or offset >= int(page.get("total") or 0):
            break
    return out[:limit]


def make_eval_run(
    *,
    models: dict[str, Any],
    run_one: Callable[..., Any],
    load_image: Callable[[Any, Any], Any],
    match: Callable[[Sequence[dict[str, Any]], Sequence[dict[str, Any]]], dict[str, Any]] | None = None,
    chunk_size: int = CHUNK_SIZE,
) -> Callable[[Any], dict[str, Any]]:
    """Build the handler. `run_one` is `agent_run.make_run_one(...)`; `match` is injectable for tests."""

    def eval_run(ctx: Any) -> dict[str, Any]:
        p = ctx.job["payload"]
        model_id = p["modelId"]
        spec = models.get(model_id)
        if spec is None:
            known = ", ".join(sorted(s.model_id for s in models.values())) or "none"
            raise NonRetryable(f"this worker does not serve model {model_id!r}; it serves: {known}")

        mode = p.get("mode", "with_tools")
        if mode not in ("with_tools", "no_tools"):
            raise NonRetryable(f"mode must be with_tools or no_tools, got {mode!r}")
        matcher = match or load_matcher()

        image_ids = _resolve_image_ids(ctx, p)
        if not image_ids:
            raise NonRetryable("no images to evaluate: the split is empty (or every id was a duplicate)")
        split = str(p.get("split") or "test")
        provider = str(p.get("provider") or "local")
        run_key = str(p.get("runKey") or f"live-{model_id[:8]}-{split}-{int(time.time())}")

        chunk: list[dict[str, Any]] = []
        run_id: str | None = None
        n = 0
        summary: dict[str, float] = {}
        skipped = failed = 0

        def flush() -> None:
            nonlocal chunk, run_id, n, summary
            if not chunk:
                return
            body: dict[str, Any] = {
                "runKey": run_key,
                "canonicalResize": bool(p.get("canonicalResize", False)),
                "backend": spec.backend,
                "stage": spec.app_stage,
                "cases": chunk,
            }
            response = ctx.client.post("/ingest/eval-run", body)
            run_id = response["runId"]
            n = int(response["n"])
            summary = {k: float(v) for k, v in (response.get("summary") or {}).items()}
            chunk = []

        for position, image_ref in enumerate(image_ids, start=1):
            meta = ctx.client.get(f"/images/{image_ref}")
            ground_truth = meta.get("groundTruth")
            if ground_truth is None:
                skipped += 1
                ctx.emit(
                    "log",
                    {
                        "imageId": image_ref,
                        "message": "skipped: the app has no ground truth for this image (a case would be a guess)",
                    },
                )
                continue
            try:
                image = load_image(ctx, image_ref)
                outcome = run_one(
                    spec,
                    image=image,
                    image_id=image_ref,
                    mode=mode,
                    max_turns=p.get("maxTurns"),
                    max_tool_calls=int(p.get("maxToolCalls", 50)),
                    canonical_resize=bool(p.get("canonicalResize", False)),
                    temperature=float(p.get("temperature", 0.0)),
                    seed=p.get("seed"),
                    on_turn=None,
                    on_artifact=None,
                    should_stop=getattr(getattr(ctx, "abort", None), "is_set", None),
                )
                case = build_case(
                    image_id=int(meta["sourceImageId"]),
                    dataset=str(meta.get("dataset") or p.get("dataset") or "dentex"),
                    split=split,
                    provider=provider,
                    model=spec.model_id,
                    ground_truth=ground_truth,
                    predictions=list(outcome.final_answer or []),
                    format_ok=bool(outcome.format_ok),
                    raw_output=_last_raw(outcome),
                    finish_reason=_finish_reason(outcome),
                    match=matcher,
                )
            except Exception as e:  # noqa: BLE001 - one bad image must not lose the whole run
                failed += 1
                ctx.emit("log", {"imageId": image_ref, "message": f"case failed: {type(e).__name__}: {e}"})
                continue

            chunk.append(case)
            ctx.emit("partial", case)
            if len(chunk) >= chunk_size:
                flush()
            ctx.emit(
                "progress",
                {
                    "pct": round(100 * position / len(image_ids)),
                    "done": position,
                    "total": len(image_ids),
                    "evaluated": n + len(chunk),
                    "skipped": skipped,
                    "failed": failed,
                },
            )

        flush()
        if run_id is None:
            raise NonRetryable(
                f"no case could be evaluated: {skipped} skipped for missing ground truth, {failed} failed"
            )
        return {"runId": run_id, "n": n, "summary": summary}

    return eval_run
