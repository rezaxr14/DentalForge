#!/usr/bin/env python3
"""Record the WP3 handlers' wire output into `fixtures/worker/wp3-recorded-events.json`.

Why this exists: the acceptance harness must validate *what the worker actually posts*, not a shape
invented by the test. This script runs the three handlers through the real `worker.JobContext.emit`
(the code that serializes `{"events": [{seq, type, data}]}`) with the model/tool layer replaced by
deterministic fakes, and writes the captured bodies next to the results they completed with.

  * `eval.run` and `al.score` need a model and a detector, so their backends are mocked here.
  * `trace.render_artifacts` needs VLM-DENTAL's tool registry; the dispatch is mocked the same way
    its unit tests do it, so no torch and no checkout are required.

The fixture is then checked twice, against the same bytes:

  * `tests/python/test_worker_openapi.py` — `jsonschema` against `docs/worker-openapi.json`;
  * `tests/m8-worker-recorded-events.test.ts` — the Zod contract.

Regenerate (only when a handler's wire shape changes on purpose):

    python examples/python-worker/record_wp3_events.py

The checked-in JSON is the source of truth; CI never regenerates it.
"""
from __future__ import annotations

import json
import sys
import threading
from pathlib import Path
from typing import Any

from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import al_score  # noqa: E402
import eval_run  # noqa: E402
import render_artifacts  # noqa: E402
import worker  # noqa: E402
from backends.base import ModelSpec, RunOutcome  # noqa: E402

OUT = HERE.parents[1] / "fixtures" / "worker" / "wp3-recorded-events.json"

UUID_A = "11111111-1111-4111-8111-111111111111"
UUID_B = "22222222-2222-4222-8222-222222222222"
UUID_RUN = "44444444-4444-4444-8444-444444444444"
UUID_TRACE = "55555555-5555-4555-8555-555555555555"
UUID_IMAGE = "66666666-6666-4666-8666-666666666666"
UUID_ARTIFACT = "77777777-7777-4777-8777-777777777777"
UUID_ARTIFACT_2 = "88888888-8888-4888-8888-888888888888"


class CaptureClient:
    """Stands in for `worker.Client`; records every body the handlers would put on the wire."""

    def __init__(self) -> None:
        self.posts: list[tuple[str, dict[str, Any]]] = []
        self.gets: list[str] = []
        self.uploads: list[tuple[str, str, bytes]] = []
        self._images = {
            UUID_A: {
                "sourceImageId": 18,
                "dataset": "dentex",
                "groundTruth": [{"quadrant": 1, "tooth_position": 1, "diagnosis": "Caries"}],
            },
            UUID_B: {"sourceImageId": 32, "dataset": "dentex", "groundTruth": []},
        }
        self._trace = {
            "traceId": UUID_TRACE,
            "imageId": UUID_IMAGE,
            "mode": "with_tools",
            "turns": [
                {
                    "idx": 0,
                    "toolCalls": [
                        {"idx": 0, "toolName": "zoom_crop", "args": {"bbox": [10, 10, 64, 64]}, "ok": True, "error": None, "artifactId": None},
                        {"idx": 1, "toolName": "window_level", "args": {"preset": "bone"}, "ok": True, "error": None, "artifactId": None},
                    ],
                }
            ],
        }

    def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        self.posts.append((path, body))
        if path == "/ingest/eval-run":
            n = sum(len(b["cases"]) for p, b in self.posts if p == "/ingest/eval-run")
            return {"runId": UUID_RUN, "n": n, "summary": {"fdi_f1": 1.0, "exact_f1": 0.5}}
        return {"accepted": len(body.get("events", [])), "leaseExtendedUntil": "2026-10-29T00:00:00.000Z"}

    def get(self, path: str) -> dict[str, Any]:
        self.gets.append(path)
        if path.startswith("/traces/"):
            return self._trace
        return self._images[path.rsplit("/", 1)[-1]]

    def upload_artifact(self, _job_id: str, name: str, mime: str, data: bytes) -> str:
        self.uploads.append((name, mime, data))
        return UUID_ARTIFACT if len(self.uploads) == 1 else UUID_ARTIFACT_2


def _job(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {"id": f"job-{kind}", "type": kind, "payload": payload}


def _capture(kind: str, payload: dict[str, Any], handler: Any) -> dict[str, Any]:
    client = CaptureClient()
    ctx = worker.JobContext(job=_job(kind, payload), client=client, abort=threading.Event())  # type: ignore[arg-type]
    result = handler(ctx)
    events = [e for path, body in client.posts if path.endswith("/events") for e in body["events"]]
    return {"jobType": kind, "events": events, "result": result}


def _spec() -> ModelSpec:
    return ModelSpec(
        model_id="app-model",
        label="app-model",
        stage="base",
        backend="openai_compat",
        base_path="app-model",
        quantization="none",
        notes=None,
    )


def _match(gt: Any, pred: Any) -> dict[str, Any]:
    tp = min(len(gt), len(pred))
    return {
        "fdi_tp": tp,
        "exact_tp": tp,
        "exact_fn": max(0, len(gt) - tp),
        "exact_fp": max(0, len(pred) - tp),
        "fdi_precision": 1.0 if tp else 0.0,
        "fdi_recall": 1.0 if tp else 0.0,
        "fdi_f1": 1.0 if tp else 0.0,
        "exact_precision": 1.0 if tp else 0.0,
        "exact_recall": 1.0 if tp else 0.0,
        "exact_f1": 1.0 if tp else 0.0,
        "closeness_score": 1.0 if tp else 0.0,
        "spatial_proximity": 1.0 if tp else 0.0,
        "diagnostic_similarity": 1.0 if tp else 0.0,
        "matched_pairs": [],
    }


def _outcome() -> RunOutcome:
    return RunOutcome(
        turns=[{"turn": 0, "status": "final", "raw_output": '{"final_answer": []}'}],
        n_tool_calls=0,
        final_answer=[{"quadrant": 1, "tooth_position": 1, "diagnosis": "Caries"}],
        format_ok=True,
    )


def _png(color: tuple[int, int, int]) -> Image.Image:
    return Image.new("RGB", (8, 6), color)


def main() -> int:
    eval_handler = eval_run.make_eval_run(
        models={"app-model": _spec()},
        run_one=lambda _spec, **_kw: _outcome(),
        load_image=lambda _ctx, image_id: image_id,
        match=_match,
        chunk_size=100,
    )
    al_handler = al_score.make_al_score(
        detect=lambda _image, _conf: ([{"conf": 0.9}, {"conf": 0.4}], 12.5),
        load_image=lambda _ctx, image_id: image_id,
    )
    render_handler = render_artifacts.make_render_artifacts(
        registry=object(),
        execute_tool_call=lambda _registry, tool, _args, _image: _png((255, 0, 0)) if tool == "zoom_crop" else _png((0, 0, 255)),
        load_image=lambda _ctx, image_id: (image_id, _png((0, 0, 0))),
    )

    streams = [
        _capture("eval.run", {"modelId": "app-model", "imageIds": [UUID_A, UUID_B], "split": "val"}, eval_handler),
        _capture("al.score", {"imageIds": [UUID_A, UUID_B], "modelId": "yolo_cv_best"}, al_handler),
        _capture("trace.render_artifacts", {"traceId": UUID_TRACE}, render_handler),
    ]
    document = {
        "$comment": (
            "Captured from examples/python-worker through worker.JobContext.emit; the model/tool layer is "
            "mocked (see record_wp3_events.py). Do not hand-edit: regenerate with that script."
        ),
        "contractVersion": worker.CONTRACT_VERSION,
        "recordedAt": "2026-10-29",
        "streams": streams,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(HERE.parents[1])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
