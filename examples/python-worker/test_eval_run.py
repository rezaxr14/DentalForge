"""`eval.run`: chunking, skip rules, idempotent run identity, case shape (WP3, ADR-0025 addendum §3)."""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import eval_run as er  # noqa: E402
from backends.base import ModelSpec, RunOutcome  # noqa: E402
from worker_errors import NonRetryable  # noqa: E402

UUID_A = "11111111-1111-4111-8111-111111111111"
UUID_B = "22222222-2222-4222-8222-222222222222"
DATASET = "33333333-3333-4333-8333-333333333333"


def _spec(model_id: str = "qwen-test") -> ModelSpec:
    return ModelSpec(
        model_id=model_id,
        label=model_id,
        stage="base",
        backend="openai_compat",
        base_path="qwen-test",
        quantization="none",
        notes=None,
    )


def _match(gt, pred):
    """A tiny stand-in with the same contract as VLM-DENTAL's matcher."""
    tp = min(len(gt), len(pred))
    pairs = [{"gt": g, "pred": p, "fdi_match": True, "exact_match": True, "closeness": 1.0,
              "spatial": 1.0, "diag_sim": 1.0} for g, p in zip(gt, pred)]
    return {
        "fdi_tp": tp, "exact_tp": tp, "exact_fn": max(0, len(gt) - tp), "exact_fp": max(0, len(pred) - tp),
        "fdi_precision": 1.0 if tp else 0.0, "fdi_recall": 1.0 if tp else 0.0, "fdi_f1": 1.0 if tp else 0.0,
        "exact_precision": 1.0 if tp else 0.0, "exact_recall": 1.0 if tp else 0.0, "exact_f1": 1.0 if tp else 0.0,
        "closeness_score": 1.0 if tp else 0.0, "spatial_proximity": 1.0 if tp else 0.0,
        "diagnostic_similarity": 1.0 if tp else 0.0, "matched_pairs": pairs,
    }


class FakeClient:
    def __init__(self, images: dict[str, dict[str, Any]], page: dict[str, Any] | None = None):
        self.images = images
        self.page = page
        self.posts: list[dict[str, Any]] = []
        self.list_calls: list[str] = []

    def get(self, path: str) -> dict[str, Any]:
        if path.startswith("/images?"):
            self.list_calls.append(path)
            return self.page or {"images": [], "total": 0}
        return self.images[path.rsplit("/", 1)[-1]]

    def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        assert path == "/ingest/eval-run"
        self.posts.append(body)
        stored = sum(len(p["cases"]) for p in self.posts)
        return {"runId": "44444444-4444-4444-8444-444444444444", "n": stored, "summary": {"fdi_f1": float(stored)}}


class FakeCtx:
    def __init__(self, payload: dict[str, Any], client: FakeClient):
        self.job = {"id": "job-1", "payload": payload}
        self.client = client
        self.events: list[tuple[str, Any]] = []

    def emit(self, type_: str, data: Any) -> None:
        self.events.append((type_, data))


def _image_meta(source_id: int, gt: list[dict[str, Any]] | None) -> dict[str, Any]:
    return {"sourceImageId": source_id, "dataset": "dentex", "groundTruth": gt}


def _outcome(answer: list[dict[str, Any]], raw: str = '{"final_answer": []}') -> RunOutcome:
    return RunOutcome(
        turns=[{"turn": 0, "status": "final", "raw_output": raw}],
        n_tool_calls=0,
        final_answer=answer,
        format_ok=True,
    )


def _handler(client: FakeClient, answers: dict[str, list[dict[str, Any]]] | None = None, chunk: int = 100):
    body = answers or {}
    return er.make_eval_run(
        models={"app-model": _spec()},
        run_one=lambda _spec, *, image_id, **_kw: _outcome(body.get(image_id, [])),
        load_image=lambda _ctx, image_id: image_id,
        match=_match,
        chunk_size=chunk,
    )


def test_happy_path_posts_one_chunk_and_reports_the_servers_totals():
    client = FakeClient({UUID_A: _image_meta(18, [{"quadrant": 1}]), UUID_B: _image_meta(32, [])})
    ctx = FakeCtx({"imageId": None, "modelId": "app-model", "imageIds": [UUID_A, UUID_B], "split": "val"}, client)
    result = _handler(client, {UUID_A: [{"quadrant": 1, "tooth_position": 1, "diagnosis": "Caries"}]})(ctx)

    assert len(client.posts) == 1
    body = client.posts[0]
    assert body["runKey"].startswith("live-")
    assert [c["image_id"] for c in body["cases"]] == [18, 32]
    assert body["backend"] == "openai_compat" and body["stage"] == "zero_shot"
    assert result == {"runId": "44444444-4444-4444-8444-444444444444", "n": 2, "summary": {"fdi_f1": 2.0}}
    partial = [d for (t, d) in ctx.events if t == "partial"]
    assert [p["image_id"] for p in partial] == [18, 32]
    # `evaluated` counts the cases already posted PLUS the ones still buffered in the open chunk;
    # with the default chunk size nothing is posted yet, so it must track the images walked.
    progress = [d for (t, d) in ctx.events if t == "progress"]
    assert [p["evaluated"] for p in progress] == [1, 2]
    assert progress[-1]["done"] == progress[-1]["total"] == 2


def test_chunk_size_bounds_every_post():
    client = FakeClient({u: _image_meta(i, []) for i, u in enumerate([UUID_A, UUID_B], start=1)})
    ctx = FakeCtx({"modelId": "app-model", "imageIds": [UUID_A, UUID_B]}, client)
    _handler(client, chunk=1)(ctx)

    assert [len(p["cases"]) for p in client.posts] == [1, 1]
    assert all(len(p["cases"]) <= er.CHUNK_SIZE for p in client.posts)


def test_an_image_without_ground_truth_is_skipped_and_logged():
    client = FakeClient({UUID_A: _image_meta(18, None), UUID_B: _image_meta(32, [])})
    ctx = FakeCtx({"modelId": "app-model", "imageIds": [UUID_A, UUID_B]}, client)
    _handler(client)(ctx)

    assert [c["image_id"] for c in client.posts[0]["cases"]] == [32]
    logs = [d for (t, d) in ctx.events if t == "log"]
    assert logs and "no ground truth" in logs[0]["message"]


def test_a_run_where_nothing_could_be_evaluated_fails_loudly():
    client = FakeClient({UUID_A: _image_meta(18, None)})
    ctx = FakeCtx({"modelId": "app-model", "imageIds": [UUID_A]}, client)
    with pytest.raises(NonRetryable, match="no case could be evaluated"):
        _handler(client)(ctx)
    assert client.posts == []


def test_research_repo_integers_are_refused_with_a_reason():
    client = FakeClient({})
    ctx = FakeCtx({"modelId": "app-model", "imageIds": [18, 32]}, client)
    with pytest.raises(NonRetryable, match="research-repo ids"):
        _handler(client)(ctx)


def test_an_unknown_mode_is_refused_before_any_work():
    client = FakeClient({UUID_A: _image_meta(18, [])})
    ctx = FakeCtx({"modelId": "app-model", "imageIds": [UUID_A], "mode": "both"}, client)
    with pytest.raises(NonRetryable, match="mode must be"):
        _handler(client)(ctx)
    assert client.posts == [] and client.list_calls == []


def test_an_unknown_model_is_refused_before_any_image_is_fetched():
    client = FakeClient({})
    ctx = FakeCtx({"modelId": "nope", "imageIds": [UUID_A]}, client)
    with pytest.raises(NonRetryable, match="does not serve model"):
        _handler(client)(ctx)
    assert client.list_calls == []


def test_without_image_ids_the_split_is_paged_through_the_contract():
    client = FakeClient(
        {UUID_A: _image_meta(18, [])},
        page={"images": [{"id": UUID_A, "sourceImageId": 18}], "total": 1},
    )
    ctx = FakeCtx({"modelId": "app-model", "datasetId": DATASET, "split": "val", "limit": 3}, client)
    _handler(client)(ctx)

    assert client.list_calls == [f"/images?datasetId={DATASET}&split=val&limit=3&offset=0"]
    assert [c["image_id"] for c in client.posts[0]["cases"]] == [18]


def test_a_missing_evaluator_dependency_is_retryable_not_fatal(monkeypatch: pytest.MonkeyPatch):
    assert er.EvaluationUnavailable.retryable is True

    def _unavailable():
        raise er.EvaluationUnavailable("VLM-DENTAL scoring is not importable: no numpy")

    monkeypatch.setattr(er, "load_matcher", _unavailable)
    client = FakeClient({UUID_A: _image_meta(18, [])})
    ctx = FakeCtx({"modelId": "app-model", "imageIds": [UUID_A]}, client)
    handler = er.make_eval_run(
        models={"app-model": _spec()},
        run_one=lambda _spec, **kw: _outcome([]),
        load_image=lambda _ctx, image_id: image_id,
    )
    with pytest.raises(er.EvaluationUnavailable):
        handler(ctx)
    assert client.posts == [], "nothing is written when the scores cannot be computed"


# --------------------------------------------------------------------------- build_case
def test_healthy_scan_needs_a_clean_answer_and_a_parseable_output():
    ok = er.build_case(
        image_id=1, dataset="dentex", split="val", provider="local", model="m",
        ground_truth=[], predictions=[], format_ok=True, raw_output="{}", finish_reason="stop", match=_match,
    )
    assert ok["fdi_correct"] and ok["exact_match"] and ok["all_exact_match"]
    assert ok["confidence"] == 1.0

    hallucinated = er.build_case(
        image_id=1, dataset="dentex", split="val", provider="local", model="m",
        ground_truth=[], predictions=[{"quadrant": 1}], format_ok=True, raw_output="{}", finish_reason="stop",
        match=_match,
    )
    assert not hallucinated["fdi_correct"]
    assert hallucinated["confidence"] is None


def test_case_fields_mirror_the_zero_shot_record():
    case = er.build_case(
        image_id=18, dataset="dentex", split="val", provider="local", model="m",
        ground_truth=[{"quadrant": 1, "tooth_position": 1, "diagnosis": "Caries"}],
        predictions=[{"quadrant": 1, "tooth_position": 1, "diagnosis": "Caries", "confidence": 0.8}],
        format_ok=True, raw_output="raw", finish_reason="final", match=_match,
    )
    for key in (
        "image_id", "dataset", "split", "provider", "model", "ground_truth", "predictions", "matched_pairs",
        "fdi_precision", "fdi_recall", "fdi_f1", "exact_precision", "exact_recall", "exact_f1",
        "closeness_score", "spatial_proximity", "diagnostic_similarity", "fdi_correct", "quadrant_correct",
        "tooth_position_correct", "diagnosis_correct", "exact_match", "all_exact_match", "final_answer",
        "raw_output", "format_ok", "finish_reason", "confidence", "timestamp",
    ):
        assert key in case, key
    assert case["fdi_correct"] and case["all_exact_match"]
    assert case["confidence"] == 0.8
    assert isinstance(case["timestamp"], float)
