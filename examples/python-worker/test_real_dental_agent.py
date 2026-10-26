"""Integration test against the REAL `dental_agent` tools (everything except the YOLO weights).

Needs VLM-DENTAL on PYTHONPATH (it is NOT run in CI, where the research package is absent):

    PYTHONPATH=/path/to/VLM-DENTAL pytest test_real_dental_agent.py

Without the package the whole module fails to import instead of silently skipping, so a green run
means the real tools ran. Run it on the machine that has the research code (and again on the GPU
box, where `locate_tooth` and `yolo.prelabel` additionally become available).
"""
from __future__ import annotations

import io
from typing import Any

import pytest
from PIL import Image

from dental_agent.utils.canonical import CANONICAL_SIZES  # noqa: E402  (ImportError here = "not run")
import dental_handlers as dh
from worker_errors import NonRetryable
from test_dental_handlers import FakeClient, FakeCtx, IMG_ID, Resp

W, H = 800, 400


def panorama_png() -> bytes:
    img = Image.new("L", (W, H), 40)
    for x in range(0, W, 25):  # something with structure so contrast/denoise do real work
        for y in range(100, 300):
            img.putpixel((x, y), 40 + (x * 7 + y) % 200)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture()
def handler() -> Any:
    handlers = dh.discover({})  # no ultralytics / weights here: tool.execute only
    assert "tool.execute" in handlers, "dental_agent imported but discover() did not advertise tool.execute"
    return handlers["tool.execute"]


def run(handler: Any, tool: str, args: dict, view: str = "native") -> tuple[dict, FakeCtx]:
    client = FakeClient(meta={"url": "http://app/x?sig=1", "expiresInSeconds": 300, "width": W, "height": H},
                        resp=Resp(200, panorama_png()))
    ctx = FakeCtx({"imageId": IMG_ID, "tool": tool, "args": args, "view": view}, client)
    return handler(ctx), ctx


@pytest.mark.parametrize("tool,args,family", [
    ("zoom_crop", {"bbox": [100, 120, 80, 100], "padding_frac": 0.25}, "CROP"),
    ("window_level", {"preset": "bone"}, "FULL"),
    ("enhance_contrast", {"factor": 1.5}, "FULL"),
    ("denoise", {"method": "bilateral", "strength": 0.6}, "FULL"),
    ("contralateral_compare", {"bbox": [100, 120, 80, 100], "quadrant": 1}, "COMPARE"),
])
def test_image_tools_run_on_the_native_image_and_canonical_view_fits_the_family_canvas(handler, tool, args, family):
    native, ctx = run(handler, tool, args, "native")
    assert native["kind"] == "image" and native["width"] > 0 and native["height"] > 0
    assert Image.open(io.BytesIO(ctx.uploads[0][2])).size == (native["width"], native["height"])

    canon, cctx = run(handler, tool, args, "canonical")
    assert (canon["width"], canon["height"]) == CANONICAL_SIZES[family]
    assert Image.open(io.BytesIO(cctx.uploads[0][2])).size == CANONICAL_SIZES[family]


def test_native_full_image_tools_keep_native_resolution(handler):
    out, _ = run(handler, "window_level", {"preset": "bone"})
    assert (out["width"], out["height"]) == (W, H)


def test_data_tools_return_plain_json(handler):
    out, ctx = run(handler, "fdi_label", {"quadrant": 3, "tooth_position": 6})
    assert out["kind"] == "data" and out["data"] == "36" and not ctx.uploads
    nudged, _ = run(handler, "nudge_crop", {"bbox": [100, 100, 50, 60], "dx_frac": 0.5})
    assert nudged["kind"] == "data" and nudged["data"]["bbox"] == [125.0, 100.0, 50.0, 60.0]
    import json
    json.dumps(nudged)  # serialisable as the job result


def test_a_tool_level_error_is_data_not_a_job_failure(handler):
    out, _ = run(handler, "nudge_crop", {"bbox": [1, 2, 3], "dx_frac": 0.0})
    assert out["kind"] == "data" and "bbox must be [x, y, w, h]" in out["data"]["error"]


def test_bad_arguments_fail_the_job_non_retryably(handler):
    with pytest.raises(NonRetryable, match="zoom_crop failed"):
        run(handler, "zoom_crop", {})  # bbox is required


def test_locate_tooth_follows_the_grounding_weights_this_machine_actually_has(handler):
    """`discover()` must wire the REAL weight state into the guard, not hard-code either answer.

    The refusal itself is unit-tested deterministically in `test_dental_handlers.py`; this test asks
    the integration question instead: on a machine WITHOUT the weights the tool refuses (never
    invents a box), and on a machine WITH them it actually runs. Assuming "no weights here" made this
    test fail on a GPU box, which is the one place the integration matters.
    """
    if "yolo.prelabel" not in dh.discover({}):
        with pytest.raises(NonRetryable, match="needs the YOLO grounding weights"):
            run(handler, "locate_tooth", {"tooth": 38})
        return

    try:
        out, _ = run(handler, "locate_tooth", {"tooth": 38})
    except NonRetryable as e:
        # The tool ran and failed on this synthetic panorama: that is the tool error path, NOT the
        # "weights missing" guard. A real box was never invented either way.
        assert "needs the YOLO grounding weights" not in str(e)
        return
    assert out["kind"] == "data"
    assert "bbox" in out["data"] or "error" in out["data"]
