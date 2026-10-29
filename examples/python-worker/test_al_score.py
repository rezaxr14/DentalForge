"""`al.score` arithmetic and handler behaviour (WP3, ADR-0025 addendum §1). Torch-free."""
from __future__ import annotations

import math
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import al_score  # noqa: E402


def test_entropy_is_zero_for_zero_or_one_box():
    assert al_score.entropy_from_confidences([]) == 0.0
    assert al_score.entropy_from_confidences([0.9]) == 0.0


def test_entropy_is_one_for_equal_confidences():
    # N equal confidences have H = log2(N); normalization makes every N land on 1.0.
    for n in (2, 3, 7):
        assert al_score.entropy_from_confidences([0.5] * n) == pytest.approx(1.0)


def test_entropy_of_two_unequal_boxes_matches_the_hand_calculation():
    # p = (0.75, 0.25) -> H = 0.811278... bits, / log2(2) = 0.811278...
    assert al_score.entropy_from_confidences([0.75, 0.25]) == pytest.approx(0.811278124, abs=1e-9)


def test_entropy_ignores_zero_confidences_and_never_exceeds_one():
    assert al_score.entropy_from_confidences([0.5, 0.5, 0.0]) == pytest.approx(1.0)
    assert 0.0 <= al_score.entropy_from_confidences([0.99, 0.01]) <= 1.0


def test_score_of_an_empty_image_is_zero_not_nan():
    row = al_score.score_confidences([])
    assert row == {"meanConf": 0.0, "minConf": 0.0, "entropy": 0.0, "nBoxes": 0}
    assert not any(isinstance(v, float) and math.isnan(v) for v in row.values())


def test_score_reports_mean_min_and_count():
    row = al_score.score_confidences([0.9, 0.6, 0.3])
    assert row["nBoxes"] == 3
    assert row["meanConf"] == pytest.approx(0.6)
    assert row["minConf"] == pytest.approx(0.3)
    assert row["entropy"] == pytest.approx(0.920624, abs=1e-5)


class FakeCtx:
    def __init__(self, payload: dict[str, Any]):
        self.job = {"id": "job-1", "payload": payload}
        self.events: list[tuple[str, Any]] = []

    def emit(self, type_: str, data: Any) -> None:
        self.events.append((type_, data))


def _detect(boxes):
    return lambda _image, _conf: ([{"conf": c} for c in boxes], 12.5)


def _handler(boxes_by_image: dict[str, list[float]], served: str | None = None):
    return al_score.make_al_score(
        detect=lambda image, conf: _detect(boxes_by_image[image])(image, conf),
        load_image=lambda _ctx, image_id: image_id,
        served_model_id=served,
    )


def test_handler_scores_every_image_and_streams_progress():
    ctx = FakeCtx({"imageIds": ["a", "b"], "modelId": "m1"})
    result = _handler({"a": [0.9], "b": [0.8, 0.4]})(ctx)
    assert [s["imageId"] for s in result["scores"]] == ["a", "b"]
    assert result["scores"][0]["nBoxes"] == 1
    assert result["scores"][1]["nBoxes"] == 2
    progress = [d for (t, d) in ctx.events if t == "progress"]
    assert [p["pct"] for p in progress] == [50, 100]
    assert progress[-1]["inferenceMs"] == 12.5


def test_handler_refuses_an_empty_image_list():
    from worker_errors import NonRetryable

    with pytest.raises(NonRetryable, match="imageIds"):
        _handler({})(FakeCtx({"imageIds": [], "modelId": "m1"}))


def test_handler_refuses_a_model_it_does_not_serve():
    from worker_errors import NonRetryable

    with pytest.raises(NonRetryable, match="serves model"):
        _handler({"a": [0.9]}, served="other")(FakeCtx({"imageIds": ["a"], "modelId": "m1"}))


def test_handler_rejects_a_threshold_outside_the_unit_interval():
    from worker_errors import NonRetryable

    with pytest.raises(NonRetryable, match="confThreshold"):
        _handler({"a": [0.9]})(FakeCtx({"imageIds": ["a"], "modelId": "m1", "confThreshold": 1.5}))
