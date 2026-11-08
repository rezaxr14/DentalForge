"""Deterministic recording of what the WP3 handlers put on the wire.

The acceptance test (`tests/python/test_wp3_acceptance.py`) must validate *real handler output* against
the published contract, not a hand-written object that happens to look right. So the three handlers run
here against fakes — a fake detector, a fake evaluation client, fake tool execution — and everything they
emit or return is captured verbatim:

  * `al.score`: its `progress` events and its result;
  * `eval.run`: its `log` / `partial` / `progress` events, the `/ingest/eval-run` bodies it POSTs, and
    its result;
  * `trace.render_artifacts`: its `log` / `progress` events and its result.

The same recording is written to `fixtures/worker/wp3-acceptance.json`, which the TypeScript test parses
with the Zod schemas. One artifact, two independent validators: a schema that drifts from the handlers
fails on at least one side.

Only non-deterministic values are normalized (uuids come from the fakes, `timestamp` is zeroed), so the
fixture is stable and `record()` can be compared with the committed file.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from PIL import Image  # noqa: E402

import al_score  # noqa: E402
import eval_run  # noqa: E402
import render_artifacts  # noqa: E402
from backends.base import ModelSpec, RunOutcome  # noqa: E402

FIXTURE_PATH = Path(__file__).resolve().parents[2] / "fixtures" / "worker" / "wp3-acceptance.json"

IMAGE_A = "11111111-1111-4111-8111-111111111111"
IMAGE_B = "22222222-2222-4222-8222-222222222222"
#: No ground truth in the app: `eval.run` must skip it and say so (a `log` event), never guess.
IMAGE_C = "33333333-3333-4333-8333-333333333333"
RUN_ID = "44444444-4444-4444-8444-444444444444"
ARTIFACT_ID = "55555555-5555-4555-8555-555555555555"
TRACE_ID = "66666666-6666-4666-8666-666666666666"


def _normalise(value: Any) -> Any:
    """Zero the one non-deterministic field, recursively. Everything else is already fixed."""
    if isinstance(value, dict):
        return {k: (0.0 if k == "timestamp" else _normalise(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [_normalise(v) for v in value]
    return value


class _Ctx:
    """The slice of `JobContext` the handlers use: payload, emit, client, upload, abort."""

    def __init__(self, payload: dict[str, Any], client: Any = None) -> None:
        self.job = {"id": "job-wp3", "payload": payload}
        self.client = client or self
        self.events: list[tuple[str, Any]] = []
        self.uploads: list[tuple[str, str, bytes]] = []

    # client
    def get(self, path: str) -> dict[str, Any]:
        raise AssertionError(f"unexpected GET {path}")

    def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        raise AssertionError(f"unexpected POST {path}")

    # job context
    def emit(self, type_: str, data: Any) -> None:
        self.events.append((type_, data))

    def upload(self, name: str, mime: str, data: bytes) -> str:
        self.uploads.append((name, mime, data))
        return ARTIFACT_ID

    @property
    def abort(self) -> None:
        return None


def _job(job_type: str, ctx: _Ctx, result: dict[str, Any]) -> dict[str, Any]:
    return {
        "jobType": job_type,
        "payload": ctx.job["payload"],
        "events": [
            {"seq": i, "type": t, "data": _normalise(d)} for i, (t, d) in enumerate(ctx.events, start=1)
        ],
        "result": _normalise(result),
    }


# ------------------------------------------------------------------ al.score
def _record_al_score() -> dict[str, Any]:
    boxes = {IMAGE_A: [0.91], IMAGE_B: [0.84, 0.37]}
    ctx = _Ctx({"imageIds": [IMAGE_A, IMAGE_B], "modelId": "yolo-wp3", "confThreshold": 0.25})
    handler = al_score.make_al_score(
        detect=lambda image, _conf: ([{"conf": c} for c in boxes[image]], 12.5),
        load_image=lambda _ctx, image_id: image_id,
        served_model_id="yolo-wp3",
    )
    return _job("al.score", ctx, handler(ctx))


# ------------------------------------------------------------------- eval.run
class _EvalClient:
    """Serves the two image metadata records and records every `/ingest/eval-run` body."""

    def __init__(self) -> None:
        self.posts: list[dict[str, Any]] = []

    def get(self, path: str) -> dict[str, Any]:
        image_id = path.rsplit("/", 1)[-1]
        if image_id == IMAGE_A:
            return {
                "sourceImageId": 18,
                "dataset": "dentex",
                "groundTruth": [{"quadrant": 1, "tooth_position": 6, "diagnosis": "Caries"}],
            }
        if image_id == IMAGE_B:
            return {"sourceImageId": 32, "dataset": "dentex", "groundTruth": []}
        if image_id == IMAGE_C:
            return {"sourceImageId": 44, "dataset": "dentex", "groundTruth": None}
        raise AssertionError(f"unexpected GET {path}")

    def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        assert path == "/ingest/eval-run", path
        self.posts.append(body)
        stored = sum(len(p["cases"]) for p in self.posts)
        return {"runId": RUN_ID, "n": stored, "summary": {"fdi_f1": 1.0, "exact_f1": 1.0}}


def _match(gt: list[dict[str, Any]], pred: list[dict[str, Any]]) -> dict[str, Any]:
    """A stand-in with the same contract as VLM-DENTAL's `match_multi_findings`."""
    tp = min(len(gt), len(pred))
    pairs = [
        {
            "gt": g,
            "pred": p,
            "fdi_match": True,
            "exact_match": True,
            "closeness": 1.0,
            "spatial": 1.0,
            "diag_sim": 1.0,
        }
        for g, p in zip(gt, pred)
    ]
    score = 1.0 if tp else 0.0
    return {
        "fdi_tp": tp,
        "exact_tp": tp,
        "exact_fn": max(0, len(gt) - tp),
        "exact_fp": max(0, len(pred) - tp),
        "fdi_precision": score,
        "fdi_recall": score,
        "fdi_f1": score,
        "exact_precision": score,
        "exact_recall": score,
        "exact_f1": score,
        "closeness_score": score,
        "spatial_proximity": score,
        "diagnostic_similarity": score,
        "matched_pairs": pairs,
    }


def _record_eval_run() -> tuple[dict[str, Any], list[dict[str, Any]]]:
    answers = {IMAGE_A: [{"quadrant": 1, "tooth_position": 6, "diagnosis": "Caries", "confidence": 0.8}]}
    client = _EvalClient()
    ctx = _Ctx(
        {
            "modelId": "app-model",
            "dataset": "dentex",
            "split": "val",
            "imageIds": [IMAGE_A, IMAGE_B, IMAGE_C],
            "runKey": "wp3-acceptance",
        },
        client=client,
    )
    spec = ModelSpec(
        model_id="qwen-wp3",
        label="qwen-wp3",
        stage="base",
        backend="openai_compat",
        base_path="qwen-wp3",
        quantization="none",
    )
    handler = eval_run.make_eval_run(
        models={"app-model": spec},
        run_one=lambda _spec, *, image_id, **_kw: RunOutcome(
            turns=[{"turn": 0, "status": "final", "raw_output": '{"final_answer": []}'}],
            final_answer=answers.get(image_id, []),
            format_ok=True,
        ),
        load_image=lambda _ctx, image_id: image_id,
        match=_match,
        # One case per POST so the recording covers both a normal chunk and the final flush.
        chunk_size=1,
    )
    job = _job("eval.run", ctx, handler(ctx))
    ingest = [{"path": "/ingest/eval-run", "body": _normalise(body)} for body in client.posts]
    return job, ingest


# ------------------------------------------------- trace.render_artifacts
class _RenderClient:
    def __init__(self, trace: dict[str, Any]) -> None:
        self.trace = trace

    def get(self, path: str) -> dict[str, Any]:
        assert path == f"/traces/{TRACE_ID}", path
        return self.trace


def _record_render() -> dict[str, Any]:
    trace = {
        "traceId": TRACE_ID,
        "imageId": IMAGE_A,
        "mode": "with_tools",
        "turns": [
            {
                "idx": 0,
                "toolCalls": [
                    {"idx": 0, "toolName": "zoom_crop", "args": {"bbox": [1, 2, 3, 4]}, "ok": True, "error": None, "artifactId": None},
                    {"idx": 1, "toolName": "window_level", "args": {"preset": "bone"}, "ok": True, "error": None, "artifactId": None},
                ],
            }
        ],
    }
    # Identical output for both calls: exercises the sha256 dedupe the ADR describes.
    same = Image.new("RGB", (8, 6), (120, 30, 30))
    ctx = _Ctx({"traceId": TRACE_ID}, client=_RenderClient(trace))
    handler = render_artifacts.make_render_artifacts(
        registry=object(),
        execute_tool_call=lambda _registry, _tool, _args, _image: same,
        load_image=lambda _ctx, _image_id: Image.new("RGB", (16, 16), (0, 0, 0)),
    )
    return _job("trace.render_artifacts", ctx, handler(ctx))


def record() -> dict[str, Any]:
    """Every recorded job plus the eval-run ingest bodies, with deterministic values."""
    eval_job, ingest = _record_eval_run()
    return {
        "generatedBy": "examples/python-worker/acceptance_fixtures.py",
        "jobs": [_record_al_score(), eval_job, _record_render()],
        "ingest": ingest,
    }
