"""`agent.run`: run one image through a model backend, streaming one `turn` event per turn.

The handler owns the contract-facing part (payload checks, model resolution, events, result) and
delegates everything model-specific to `backends/`. Two invariants:

  * **A job never runs a model the app did not ask for.** `modelId` is the app's registry UUID; the
    worker resolves it to one of its own `WORKER_MODELS_FILE` entries, rebuilt at registration, and
    refuses anything else instead of guessing.
  * **Turns are streamed, never fabricated.** `openai_compat` emits each turn as it happens;
    `torch_hf` emits them after the run because upstream has no per-turn hook. The first progress
    event says which backend and stage produced the run, so the app can label it.
"""
from __future__ import annotations

import re
from typing import Any, Callable

from backends.base import ModelSpec, RunOutcome, tolerant_findings
from worker_errors import NonRetryable


def _normalise_turn(turn: dict[str, Any]) -> dict[str, Any]:
    """A `Turn` the app can store: tolerant final answer, and a tool name that is always a string.

    `loop.py` records `tool_name: None` for a model-emitted call without a `tool` key; the app's
    `ToolCallRecord` requires a string, so an unnamed call is stored as `""` and keeps its
    `tool_error`. Nothing is dropped: the failed call stays visible.
    """
    out = dict(turn)
    parsed = out.get("parsed")
    if isinstance(parsed, dict) and "final_answer" in parsed:
        parsed = dict(parsed)
        parsed["final_answer"] = tolerant_findings(parsed["final_answer"])
        out["parsed"] = parsed
    calls = out.get("tool_calls_this_turn")
    if isinstance(calls, list):
        out["tool_calls_this_turn"] = [
            {**c, "tool_name": str(c.get("tool_name") or "")} if isinstance(c, dict) else c for c in calls
        ]
    return out


def _cohort(model_id: str) -> str:
    """A cohort slug the app accepts (`^[a-z0-9][a-z0-9_]{0,63}$`, never `hybrid`).

    The cohort names the model that produced the run, so traces of different local models do not
    collide on the app's identity (dataset, image, cohort, mode).
    """
    slug = re.sub(r"[^a-z0-9]+", "_", model_id.lower()).strip("_")[:64]
    if not slug:
        return "live"
    return "live_model" if slug == "hybrid" else slug


def ingest_live_trace(
    ctx: Any,
    *,
    image_id: Any,
    spec: ModelSpec,
    mode: str,
    outcome: RunOutcome,
) -> str | None:
    """Store the run as a trace so Trace Explorer can open it (ADR-0025). Returns its id or None.

    The ground truth comes from the app (`GET /images/{id}`): this worker only has pixels. If the
    app knows no ground truth for the image, ingestion is SKIPPED with a log - a live run must never
    invent `[]` (a healthy scan) for an image whose truth is simply unknown.

    Any other failure is raised: the model already ran, so a silent loss of its provenance is worse
    than a failed job that an operator can see.
    """
    meta = ctx.client.get(f"/images/{image_id}")
    ground_truth = meta.get("groundTruth")
    dataset = meta.get("dataset")
    source_image_id = meta.get("sourceImageId")
    if ground_truth is None or dataset is None or source_image_id is None:
        print(
            f"[agent.run] not ingesting a trace: the app has no ground truth for image {image_id} "
            "(dataset/sourceImageId missing or groundTruth null)",
            flush=True,
        )
        return None

    body = {
        "source": {
            "cohort": _cohort(spec.model_id),
            "mode": mode,
            "verified": False,
            "sourceFile": f"agent.run:{spec.backend}:{spec.stage}",
            "backend": spec.backend,
            "stage": spec.stage,
        },
        "traces": [
            {
                "image_id": int(source_image_id),
                "dataset": dataset,
                "ground_truth": ground_truth,
                "turns": [_normalise_turn(t) for t in outcome.turns],
                "tool_calls": outcome.n_tool_calls,
                "final_answer": tolerant_findings(outcome.final_answer),
                "format_ok": outcome.format_ok,
            }
        ],
    }
    response = ctx.client.post("/ingest/traces", body)
    results = response.get("results") or []
    item = results[0] if results else {}
    if item.get("outcome") == "rejected":
        raise NonRetryable(f"the app rejected this run's trace: {item.get('reason')}")
    return item.get("traceId")


def make_agent_run(
    *,
    models: dict[str, ModelSpec],
    torch_backend: Any = None,
    openai_backend: Any = None,
    load_image: Callable[[Any, Any], Any],
    registry_factory: Callable[[], Any] | None = None,
    run_loop: Callable[..., RunOutcome] | None = None,
) -> Callable[[Any], dict[str, Any]]:
    """Build the handler. `run_loop` is injectable so tests exercise the handler without a server."""

    def agent_run(ctx: Any) -> dict[str, Any]:
        p = ctx.job["payload"]
        model_id = p["modelId"]
        spec = models.get(model_id)
        if spec is None:
            known = ", ".join(sorted(s.model_id for s in models.values())) or "none"
            raise NonRetryable(f"this worker does not serve model {model_id!r}; it serves: {known}")
        if spec.backend == "torch_hf" and torch_backend is None:
            raise NonRetryable(f"model {spec.model_id!r} needs the torch_hf backend, which this worker did not start")
        if spec.backend == "openai_compat" and openai_backend is None:
            raise NonRetryable(f"model {spec.model_id!r} needs the openai_compat backend, which this worker did not start")

        mode = p.get("mode", "with_tools")
        if mode not in ("with_tools", "no_tools"):
            raise NonRetryable(f"mode must be with_tools or no_tools, got {mode!r}")
        max_turns = p.get("maxTurns")
        max_tool_calls = int(p.get("maxToolCalls", 50))
        temperature = float(p.get("temperature", 0.0))
        seed = p.get("seed")

        image = load_image(ctx, p["imageId"])
        ctx.emit(
            "progress",
            {
                "pct": 0,
                "backend": spec.backend,
                "stage": spec.app_stage,
                "modelId": model_id,
                "modelKey": spec.model_id,
                "turnsStreamed": spec.backend != "torch_hf",
                "note": "Test backend (not the research model)" if spec.stage == "test" else None,
            },
        )

        def on_turn(turn: dict[str, Any]) -> None:
            ctx.emit("turn", _normalise_turn(turn))

        def on_artifact(turn_idx: int, call_idx: int, tool_name: str, png: bytes) -> str:
            name = f"{tool_name}_{turn_idx}_{call_idx}.png"
            artifact_id = ctx.upload(name, "image/png", png)
            ctx.emit(
                "artifact",
                {"turnIdx": turn_idx, "callIdx": call_idx, "artifactId": artifact_id, "name": name, "mime": "image/png"},
            )
            return artifact_id

        common = {
            "mode": mode,
            "max_turns": max_turns,
            "max_tool_calls": max_tool_calls,
            "canonical_resize": bool(p.get("canonicalResize", False)),
            "temperature": temperature,
            "seed": seed,
            "on_turn": on_turn,
            "on_artifact": on_artifact,
            "should_stop": getattr(getattr(ctx, "abort", None), "is_set", None),
        }

        if spec.backend == "torch_hf":
            outcome = torch_backend.run(spec, image=image, image_id=p["imageId"], **common)
        else:
            if run_loop is None:  # pragma: no cover - wired by worker.py
                raise NonRetryable("openai_compat loop is not wired")
            if mode == "with_tools" and registry_factory is None:
                raise NonRetryable("with_tools needs a ToolRegistry, which this worker did not provide")
            outcome = run_loop(
                openai_backend.completer(spec.base_path),
                registry=registry_factory() if mode == "with_tools" else None,
                image=image,
                **common,
            )

        trace_id = ingest_live_trace(
            ctx, image_id=p["imageId"], spec=spec, mode=mode, outcome=outcome
        )

        result: dict[str, Any] = {
            "finalAnswer": tolerant_findings(outcome.final_answer),
            "nTurns": outcome.n_turns,
            "nToolCalls": outcome.n_tool_calls,
            "formatOk": outcome.format_ok,
        }
        if trace_id:
            result["traceId"] = trace_id
        return result

    return agent_run
