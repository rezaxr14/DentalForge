"""`al.score`: how uncertain the grounding detector is on each image (WP3).

The active-learning queue needs a ranking it can explain, so the entropy here is **defined in
ADR-0025 (WP3 addendum §1)** before the code:

    p_i      = c_i / sum(c_j)                 over the detector's retained boxes
    entropy  = H(p) / log2(N)   H in bits     normalized, 0 when N <= 1, 0 when N == 0
    meanConf = mean(c_i), minConf = min(c_i)  0 when N == 0 (never NaN)

Justification in one line: Ultralytics exposes only the winning class's confidence, so class-probability
entropy would have to be invented; confidence-spread entropy answers "how ambiguous is the detector on
this image?" and `nBoxes` keeps one confident box from looking as certain as an empty image.

The detector call is injected, so the scoring arithmetic is testable with no torch and no weights.
"""
from __future__ import annotations

import math
from typing import Any, Callable, Iterable, Sequence

from worker_errors import NonRetryable


def entropy_from_confidences(confs: Sequence[float]) -> float:
    """Normalized Shannon entropy (bits) of the detection confidences; see the module docstring.

    Zero-confidence detections are ignored: they are below any usable threshold and would otherwise
    depress the score of an otherwise certain image.
    """
    positive = [c for c in confs if c > 0]
    n = len(positive)
    if n <= 1:
        return 0.0
    total = sum(positive)
    h = -sum((c / total) * math.log2(c / total) for c in positive)
    # Guard the floating-point edge: H is exactly log2(n) when the confidences are equal.
    return min(1.0, max(0.0, h / math.log2(n)))


def score_confidences(confs: Sequence[float]) -> dict[str, Any]:
    """The four numbers `al.score` returns for one image, from its box confidences."""
    n = len(confs)
    if n == 0:
        return {"meanConf": 0.0, "minConf": 0.0, "entropy": 0.0, "nBoxes": 0}
    return {
        "meanConf": float(sum(confs) / n),
        "minConf": float(min(confs)),
        "entropy": entropy_from_confidences(confs),
        "nBoxes": n,
    }


def make_al_score(
    *,
    detect: Callable[[Any, float], tuple[list[dict[str, Any]], float]],
    load_image: Callable[[Any, Any], Any],
    served_model_id: str | None = None,
) -> Callable[[Any], dict[str, Any]]:
    """Build the handler. `detect(image, conf)` returns (boxes, inference_ms), as `yolo.prelabel` reads them."""

    def al_score(ctx: Any) -> dict[str, Any]:
        p = ctx.job["payload"]
        model_id = p.get("modelId") or ""
        if served_model_id and model_id != served_model_id:
            raise NonRetryable(f"this worker serves model {served_model_id!r}, not {model_id!r}")
        image_ids = p.get("imageIds")
        if not isinstance(image_ids, list) or not image_ids:
            raise NonRetryable("payload.imageIds must be a non-empty list")
        conf = float(p.get("confThreshold", 0.25))
        if not 0.0 <= conf <= 1.0:
            raise NonRetryable(f"confThreshold {conf} is outside [0, 1]")

        scores: list[dict[str, Any]] = []
        for i, image_id in enumerate(image_ids):
            image = load_image(ctx, image_id)
            boxes, inference_ms = detect(image, conf)
            # Confidence is a float per box; the model may return it as numpy.float32.
            row = {"imageId": image_id, **score_confidences([float(b["conf"]) for b in boxes])}
            scores.append(row)
            ctx.emit(
                "progress",
                {
                    "pct": round(100 * (i + 1) / len(image_ids)),
                    "done": i + 1,
                    "total": len(image_ids),
                    **{k: row[k] for k in ("meanConf", "minConf", "entropy", "nBoxes")},
                    "inferenceMs": inference_ms,
                },
            )
        return {"scores": scores}

    return al_score
