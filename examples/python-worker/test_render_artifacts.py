"""`trace.render_artifacts`: dedupe, skip rules, CLI shape (WP3, ADR-0025 addendum §4). Torch-free."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

import render_artifacts as ra  # noqa: E402
from worker_errors import NonRetryable  # noqa: E402


class FakeCtx:
    def __init__(self, payload: dict[str, Any], trace: dict[str, Any]):
        self.job = {"id": "job-1", "payload": payload}
        self.trace = trace
        self.events: list[tuple[str, Any]] = []
        self.uploads: list[tuple[str, str, bytes]] = []
        self.client = self

    def get(self, path: str) -> dict[str, Any]:
        assert path == "/traces/t-1", path
        return self.trace

    def emit(self, type_: str, data: Any) -> None:
        self.events.append((type_, data))

    def upload(self, name: str, mime: str, data: bytes) -> str:
        self.uploads.append((name, mime, data))
        return f"artifact-{len(self.uploads)}"


def _trace(*calls: dict[str, Any]) -> dict[str, Any]:
    return {"traceId": "t-1", "imageId": "img-1", "mode": "with_tools", "turns": [{"idx": 0, "toolCalls": list(calls)}]}


def _call(idx: int, tool: str, ok: bool = True) -> dict[str, Any]:
    return {"idx": idx, "toolName": tool, "args": {}, "ok": ok, "error": None, "artifactId": None}


def _image(color: tuple[int, int, int]) -> Image.Image:
    return Image.new("RGB", (8, 6), color)


def _handler(outputs: dict[str, Any], registry_calls: list[str] | None = None):
    def execute(_registry: Any, tool: str, _args: dict[str, Any], _image: Any) -> Any:
        if registry_calls is not None:
            registry_calls.append(tool)
        value = outputs[tool]
        if isinstance(value, Exception):
            raise value
        return value

    return ra.make_render_artifacts(
        registry=object(),
        execute_tool_call=execute,
        load_image=lambda _ctx, image_id: (image_id, _image((0, 0, 0))),
    )


def test_two_calls_with_identical_output_upload_once_but_keep_both_positions():
    outputs = {"zoom_crop": _image((255, 0, 0)), "window_level": _image((255, 0, 0))}
    ctx = FakeCtx({"traceId": "t-1"}, _trace(_call(0, "zoom_crop"), _call(1, "window_level")))
    result = _handler(outputs)(ctx)

    assert len(ctx.uploads) == 1, "identical PNG bytes must be uploaded once"
    assert [a["artifactId"] for a in result["artifacts"]] == ["artifact-1", "artifact-1"]
    assert [(a["turnIdx"], a["callIdx"]) for a in result["artifacts"]] == [(0, 0), (0, 1)]
    # The contract is `additionalProperties: false`; the dedupe hash is internal and must not leak
    # into the result (it made /complete reject the job).
    assert all(set(a) == {"turnIdx", "callIdx", "artifactId"} for a in result["artifacts"])


def test_distinct_outputs_are_uploaded_separately():
    outputs = {"zoom_crop": _image((255, 0, 0)), "window_level": _image((0, 0, 255))}
    ctx = FakeCtx({"traceId": "t-1"}, _trace(_call(0, "zoom_crop"), _call(1, "window_level")))
    result = _handler(outputs)(ctx)

    assert len(ctx.uploads) == 2
    assert [a["artifactId"] for a in result["artifacts"]] == ["artifact-1", "artifact-2"]


def test_data_only_tools_are_skipped_silently():
    outputs = {"zoom_crop": _image((1, 2, 3)), "locate_tooth": {"bbox": [0, 0, 1, 1]}}
    ctx = FakeCtx({"traceId": "t-1"}, _trace(_call(0, "locate_tooth"), _call(1, "zoom_crop")))
    result = _handler(outputs)(ctx)

    assert len(result["artifacts"]) == 1
    assert result["artifacts"][0]["callIdx"] == 1
    assert ctx.events and ctx.events[-1][0] == "progress"
    assert ctx.events[-1][1]["skippedData"] == 1


def test_a_call_that_failed_originally_is_not_re_executed():
    outputs = {"zoom_crop": _image((1, 2, 3))}
    seen: list[str] = []
    ctx = FakeCtx({"traceId": "t-1"}, _trace(_call(0, "broken", ok=False), _call(1, "zoom_crop")))
    result = _handler(outputs, seen)(ctx)

    assert seen == ["zoom_crop"]
    assert len(result["artifacts"]) == 1
    logs = [d for (t, d) in ctx.events if t == "log"]
    assert logs and "not re-executing failed call" in logs[0]["message"]


def test_one_raising_tool_does_not_lose_the_other_artifacts():
    outputs = {"broken": RuntimeError("boom"), "zoom_crop": _image((9, 9, 9))}
    ctx = FakeCtx({"traceId": "t-1"}, _trace(_call(0, "broken"), _call(1, "zoom_crop")))
    result = _handler(outputs)(ctx)

    assert len(result["artifacts"]) == 1
    logs = [d for (t, d) in ctx.events if t == "log"]
    assert "broken failed: RuntimeError: boom" in logs[0]["message"]


def test_a_trace_with_no_renderable_call_fails_instead_of_completing_empty():
    ctx = FakeCtx({"traceId": "t-1"}, _trace(_call(0, "locate_tooth")))
    with pytest.raises(NonRetryable, match="no tool call produced an image"):
        _handler({"locate_tooth": {"bbox": [0, 0, 1, 1]}})(ctx)


def test_trace_ids_are_validated_before_any_work():
    with pytest.raises(NonRetryable, match="traceId"):
        _handler({})(FakeCtx({}, {}))


def test_file_shape_is_normalized_with_turn_and_call_indices():
    trace = {
        "turns": [
            {"turn": 0, "tool_calls_this_turn": [{"tool_name": "zoom_crop", "args": {"bbox": [1, 2, 3, 4]}}]},
            {"turn": 1, "tool_calls_this_turn": [{"tool_name": "window_level", "args": "{\"preset\": \"bone\"}"}]},
        ]
    }
    calls = list(ra.calls_from_file(trace))
    assert [(t, c, name, ok) for (t, c, name, _args, ok) in calls] == [
        (0, 0, "zoom_crop", True),
        (1, 0, "window_level", True),
    ]
    assert calls[0][3] == {"bbox": [1, 2, 3, 4]}
    assert calls[1][3] == {"preset": "bone"}, "JSON-encoded args are decoded, not passed as a string"


def test_cli_writes_one_png_per_distinct_output(tmp_path: Path):
    trace_path = tmp_path / "trace.json"
    trace_path.write_text(
        json.dumps({"turns": [{"turn": 0, "tool_calls_this_turn": [{"tool_name": "zoom_crop", "args": {}}]}]}),
        encoding="utf-8",
    )
    image_path = tmp_path / "image.png"
    _image((4, 5, 6)).save(image_path)

    def execute(_registry: Any, _tool: str, _args: dict[str, Any], _source: Any) -> Any:
        return _image((7, 8, 9))

    written = ra.render_trace_file(
        trace_path=trace_path,
        image_path=image_path,
        out_dir=tmp_path / "out",
        registry=object(),
        execute_tool_call=execute,
    )
    assert [p.name for p in written] == ["zoom_crop_0_0.png"]
    assert written[0].is_file()
