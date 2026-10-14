"""Unit tests for dental_handlers with injected fakes: no GPU, no weights, no research package.

Run from this directory:  pip install -r requirements.txt pytest pillow && pytest test_dental_handlers.py
(`test_real_dental_agent.py` exercises the real tools and needs VLM-DENTAL on PYTHONPATH.)
"""
from __future__ import annotations

import io
import sys
import types
from typing import Any

import pytest
from PIL import Image

import dental_handlers as dh
import worker
import worker_errors
from worker_errors import ContractError, NonRetryable

IMG_ID = "01a133a6-1dd3-7754-9e93-4f3f427da7ce"


def png_bytes(w: int = 40, h: int = 30) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (10, 20, 30)).save(buf, format="PNG")
    return buf.getvalue()


class Resp:
    def __init__(self, status: int = 200, content: bytes = b""):
        self.status_code, self.content = status, content

    @property
    def is_success(self) -> bool:
        return 200 <= self.status_code < 300


class FakeHttp:
    def __init__(self, resp: Resp):
        self.resp, self.calls = resp, []

    def get(self, *args: Any, **kwargs: Any) -> Resp:
        self.calls.append((args, kwargs))
        return self.resp


class FakeClient:
    def __init__(self, *, meta: dict | None = None, resp: Resp | None = None, error: ContractError | None = None):
        self.meta = meta or {"url": "http://app/api/storage/k?sig=1", "expiresInSeconds": 300, "width": 40, "height": 30}
        self.http = FakeHttp(resp or Resp(200, png_bytes()))
        self.error, self.get_calls = error, []

    def get(self, path: str) -> dict:
        self.get_calls.append(path)
        if self.error:
            raise self.error
        return self.meta


class FakeCtx:
    def __init__(self, payload: dict, client: FakeClient | None = None):
        self.job = {"id": "job-1", "type": "x", "payload": payload, "attempt": 1}
        self.client = client or FakeClient()
        self.uploads: list[tuple[str, str, bytes]] = []

    def upload(self, name: str, mime: str, data: bytes) -> str:
        self.uploads.append((name, mime, data))
        return "00000000-0000-4000-8000-000000000001"


# ------------------------------------------------------------------ shared types
def test_handler_modules_share_the_exact_exception_classes_run_job_checks():
    # `python worker.py` runs the file as __main__; a handler importing worker would get a second copy
    # whose NonRetryable is a different class, and run_job would report non-retryable failures as retryable.
    assert worker.NonRetryable is worker_errors.NonRetryable is dh.NonRetryable
    assert worker.ContractError is worker_errors.ContractError is dh.ContractError


def test_run_job_reports_a_handler_nonretryable_as_retryable_false():
    posted: list[tuple[str, dict]] = []

    class C:
        def post(self, path: str, body: dict) -> dict:
            posted.append((path, body))
            return {}

    def boom(ctx: Any) -> dict:
        raise dh.NonRetryable("bad args")

    worker.HANDLERS["test.boom"] = boom
    try:
        worker.run_job(C(), {"id": "abcdef012345", "type": "test.boom", "attempt": 1, "payload": {}}, set())
    finally:
        del worker.HANDLERS["test.boom"]
    assert posted[-1][0].endswith("/fail")
    assert posted[-1][1]["error"] == {"code": "handler_error", "message": "bad args", "retryable": False}


# ------------------------------------------------------------------ ImageSource
def test_image_source_fetches_native_pixels_without_a_bearer_header_and_caches():
    src, ctx = dh.ImageSource(), FakeCtx({})
    img = src(ctx, IMG_ID)
    assert (img.width, img.height, img.mode) == (40, 30, "RGB")
    assert ctx.client.get_calls == [f"/images/{IMG_ID}"]
    assert ctx.client.http.calls == [(("http://app/api/storage/k?sig=1",), {})]  # signed URL: no auth header
    assert src(ctx, IMG_ID) is img and len(ctx.client.get_calls) == 1  # cached


def test_image_source_evicts_beyond_its_cache_size():
    src, ctx = dh.ImageSource(cache_size=1), FakeCtx({})
    other = "01a133a6-1dd3-7754-9e93-4f3f427da7cf"
    src(ctx, IMG_ID)
    src(ctx, other)
    src(ctx, IMG_ID)
    assert len(ctx.client.get_calls) == 3


@pytest.mark.parametrize("bad", ["12", 12, "not-a-uuid", ""])
def test_image_source_refuses_ids_it_cannot_resolve(bad: Any):
    with pytest.raises(NonRetryable, match="not a TraceForge image UUID"):
        dh.ImageSource()(FakeCtx({}), bad)


def test_image_source_maps_404_to_nonretryable_but_lets_other_contract_errors_through():
    with pytest.raises(NonRetryable, match="not found"):
        dh.ImageSource()(FakeCtx({}, FakeClient(error=ContractError(404, "not_found", "x"))), IMG_ID)
    with pytest.raises(ContractError) as e:  # 503 = server down: the main loop backs off, the job is not failed
        dh.ImageSource()(FakeCtx({}, FakeClient(error=ContractError(503, "unavailable", "x", 5.0))), IMG_ID)
    assert e.value.status == 503


def test_image_source_download_failure_is_retryable_and_size_mismatch_is_not():
    with pytest.raises(RuntimeError, match="HTTP 500"):
        dh.ImageSource()(FakeCtx({}, FakeClient(resp=Resp(500))), IMG_ID)
    wrong = {"url": "http://x", "expiresInSeconds": 1, "width": 100, "height": 100}
    with pytest.raises(NonRetryable, match="stored size 100x100 != decoded 40x30"):
        dh.ImageSource()(FakeCtx({}, FakeClient(meta=wrong)), IMG_ID)


# ------------------------------------------------------------------ tool.execute
class FakeRegistry:
    def __init__(self, tools: set[str]):
        self.tools = tools

    def get(self, name: str) -> Any:
        return object() if name in self.tools else None


def make_tool_execute(result: Any = None, *, raises: Exception | None = None, grounding: bool = True,
                      tools: set[str] | None = None):
    seen: dict[str, Any] = {"canonical": []}

    def execute_tool_call(registry: Any, name: str, args: dict, image: Any) -> Any:
        seen["call"] = (name, args, image)
        if raises:
            raise raises
        return result

    def to_canonical(img: Image.Image, family: str) -> Image.Image:
        seen["canonical"].append(family)
        return Image.new("RGB", (448, 672))

    handler = dh.make_tool_execute(
        registry=FakeRegistry(tools or {"zoom_crop", "locate_tooth", "fdi_label", "nudge_crop"}),
        execute_tool_call=execute_tool_call,
        to_canonical=to_canonical,
        family_for_tool=lambda name: "CROP",
        load_image=lambda ctx, image_id: Image.new("RGB", (40, 30)),
        grounding_ready=lambda: grounding,
    )
    return handler, seen


def test_tool_execute_uploads_image_results_as_png_artifacts():
    handler, seen = make_tool_execute(Image.new("RGB", (20, 10), (200, 0, 0)))
    ctx = FakeCtx({"imageId": IMG_ID, "tool": "zoom_crop", "args": {"bbox": [1, 2, 3, 4]}, "view": "native"})
    out = handler(ctx)
    assert out["kind"] == "image" and (out["width"], out["height"]) == (20, 10)
    assert out["artifactId"] == "00000000-0000-4000-8000-000000000001" and out["durationMs"] >= 0
    name, mime, data = ctx.uploads[0]
    assert (name, mime) == ("zoom_crop_01a133a6.png", "image/png")
    assert Image.open(io.BytesIO(data)).size == (20, 10)  # really a PNG of the tool output
    assert seen["call"][0] == "zoom_crop" and seen["call"][1] == {"bbox": [1, 2, 3, 4]}
    assert seen["canonical"] == []  # native view: output untouched


def test_tool_execute_canonical_view_resamples_only_the_rendered_output():
    handler, seen = make_tool_execute(Image.new("RGB", (20, 10)))
    ctx = FakeCtx({"imageId": IMG_ID, "tool": "zoom_crop", "args": {}, "view": "canonical"})
    out = handler(ctx)
    assert seen["canonical"] == ["CROP"] and (out["width"], out["height"]) == (448, 672)
    assert seen["call"][2].size == (40, 30)  # the tool still ran on the NATIVE image


@pytest.mark.parametrize("result", [
    {"tooth": 38, "confidence": 0.9, "bbox": [1.0, 2.0, 3.0, 4.0]},
    {"error": "Tooth 38 not found in this radiograph."},  # a tool answer the agent must see, not a job failure
    "36",
    None,
])
def test_tool_execute_returns_non_image_results_as_data(result: Any):
    handler, _ = make_tool_execute(result)
    ctx = FakeCtx({"imageId": IMG_ID, "tool": "fdi_label", "args": {"quadrant": 3, "tooth_position": 6}})
    out = handler(ctx)
    assert out["kind"] == "data" and out["data"] == result and not ctx.uploads


def test_tool_execute_refuses_what_it_cannot_do_without_fetching_the_image():
    fetched: list[Any] = []

    def load(ctx: Any, image_id: Any) -> Any:
        fetched.append(image_id)
        return Image.new("RGB", (4, 4))

    handler = dh.make_tool_execute(
        registry=FakeRegistry({"zoom_crop", "locate_tooth"}), execute_tool_call=lambda *a: None,
        to_canonical=lambda i, f: i, family_for_tool=lambda n: "CROP", load_image=load, grounding_ready=lambda: False)
    with pytest.raises(NonRetryable, match="locate_tooth needs the YOLO grounding weights"):
        handler(FakeCtx({"imageId": IMG_ID, "tool": "locate_tooth", "args": {"tooth": 38}}))
    with pytest.raises(NonRetryable, match="'denoise' is not registered"):
        handler(FakeCtx({"imageId": IMG_ID, "tool": "denoise", "args": {}}))
    with pytest.raises(NonRetryable, match="args must be an object"):
        handler(FakeCtx({"imageId": IMG_ID, "tool": "zoom_crop", "args": [1, 2]}))
    assert fetched == []


def test_tool_execute_turns_a_tool_exception_into_a_nonretryable_failure():
    handler, _ = make_tool_execute(raises=TypeError("missing 1 required positional argument: 'bbox'"))
    with pytest.raises(NonRetryable, match=r"zoom_crop failed: TypeError: missing 1 required"):
        handler(FakeCtx({"imageId": IMG_ID, "tool": "zoom_crop", "args": {}}))


# ------------------------------------------------------------------ yolo.prelabel
class T:
    """Stands in for a torch tensor: ultralytics' Boxes expose .tolist()."""

    def __init__(self, v: list):
        self.v = v

    def tolist(self) -> list:
        return self.v


class FakeModel:
    def __init__(self, cls: list, conf: list, xywh: list, empty: bool = False):
        self.cls, self.conf, self.xywh, self.empty, self.calls = cls, conf, xywh, empty, []

    def predict(self, image: Any, verbose: bool, conf: float) -> list:
        self.calls.append({"size": image.size, "verbose": verbose, "conf": conf})
        if self.empty:
            return []
        boxes = types.SimpleNamespace(cls=T(self.cls), conf=T(self.conf), xywh=T(self.xywh))
        return [types.SimpleNamespace(boxes=boxes)]


def make_prelabel(model: FakeModel, served: str | None = None):
    return dh.make_yolo_prelabel(get_model=lambda: model, served_model_id=served,
                                 load_image=lambda ctx, image_id: Image.new("RGB", (400, 300)))


def test_yolo_prelabel_returns_native_pixel_boxes_with_fdi_numbers_sorted_by_confidence():
    # classIdx = (quadrant-1)*8 + (position-1): 0 -> 11, 10 -> 23, 31 -> 48.
    model = FakeModel(cls=[10.0, 0.0, 31.0], conf=[0.5, 0.9, 0.7],
                      xywh=[[100, 100, 40, 60], [10, 10, 40, 40], [390, 290, 60, 40]])
    out = make_prelabel(model)(FakeCtx({"imageId": IMG_ID, "modelId": "m1", "confThreshold": 0.3}))
    assert model.calls == [{"size": (400, 300), "verbose": False, "conf": 0.3}]
    assert out["modelId"] == "m1" and out["inferenceMs"] >= 0
    assert [(b["fdiQuadrant"], b["fdiPosition"], b["classIdx"]) for b in out["boxes"]] == [(1, 1, 0), (4, 8, 31), (2, 3, 10)]
    by_class = {b["classIdx"]: b for b in out["boxes"]}
    assert by_class[10]["bbox"] == [80.0, 70.0, 40.0, 60.0]  # centre -> top-left, fully inside
    assert by_class[0]["bbox"] == [0.0, 0.0, 30.0, 30.0]  # centre (10,10) 40x40 spans -10..30: CUT at the origin, not shifted
    assert by_class[31]["bbox"] == [360.0, 270.0, 40.0, 30.0]  # centre (390,290) 60x40 hangs over the bottom-right: cut
    assert by_class[0]["conf"] == 0.9 and by_class[31]["conf"] == 0.7


def test_yolo_prelabel_with_no_detections_is_a_valid_empty_result():
    out = make_prelabel(FakeModel([], [], []))(FakeCtx({"imageId": IMG_ID, "modelId": "m1"}))
    assert out["boxes"] == []


def test_yolo_prelabel_default_threshold_matches_the_contract():
    model = FakeModel([], [], [])
    make_prelabel(model)(FakeCtx({"imageId": IMG_ID, "modelId": "m1"}))
    assert model.calls[0]["conf"] == 0.25


def test_yolo_prelabel_refuses_a_different_model_than_the_one_loaded():
    with pytest.raises(NonRetryable, match="serves model 'yolo-a', not 'yolo-b'"):
        make_prelabel(FakeModel([], [], []), served="yolo-a")(FakeCtx({"imageId": IMG_ID, "modelId": "yolo-b"}))
    make_prelabel(FakeModel([], [], []), served="yolo-a")(FakeCtx({"imageId": IMG_ID, "modelId": "yolo-a"}))


def test_yolo_prelabel_never_drops_a_detection_silently_or_accepts_a_bad_threshold():
    with pytest.raises(NonRetryable, match="class index 32"):
        make_prelabel(FakeModel([32.0], [0.9], [[5, 5, 2, 2]]))(FakeCtx({"imageId": IMG_ID, "modelId": "m"}))
    with pytest.raises(NonRetryable, match="outside"):
        make_prelabel(FakeModel([], [], []))(FakeCtx({"imageId": IMG_ID, "modelId": "m", "confThreshold": 1.5}))
    with pytest.raises(RuntimeError, match="no result object"):
        make_prelabel(FakeModel([], [], [], empty=True))(FakeCtx({"imageId": IMG_ID, "modelId": "m"}))


# ------------------------------------------------------------------ discover()
def _fake_dental_agent(monkeypatch: pytest.MonkeyPatch, *, model: Any) -> None:
    def mod(name: str, **attrs: Any) -> None:
        m = types.ModuleType(name)
        m.__dict__.update(attrs)
        monkeypatch.setitem(sys.modules, name, m)

    class Grounder:
        model_path = "data/models/missing/best.pt"

        def __init__(self) -> None:
            self.model = model

        @classmethod
        def get_instance(cls) -> "Grounder":
            return cls()

    mod("dental_agent")
    mod("dental_agent.tools")
    mod("dental_agent.tools.grounding", ToothGrounder=Grounder)
    mod("dental_agent.tools.registry", ToolRegistry=types.SimpleNamespace(create_default=lambda: FakeRegistry({"zoom_crop"})))
    mod("dental_agent.agent")
    mod("dental_agent.agent.tool_dispatch", execute_tool_call=lambda *a: None)
    mod("dental_agent.utils")
    mod("dental_agent.utils.canonical", to_canonical=lambda i, f: i, family_for_tool=lambda n: "CROP")


def test_discover_advertises_nothing_when_the_research_package_is_absent(monkeypatch: pytest.MonkeyPatch, capsys):
    for name in ("dental_agent", "dental_agent.tools.grounding", "dental_agent.tools.registry",
                 "dental_agent.agent.tool_dispatch", "dental_agent.utils.canonical"):
        monkeypatch.setitem(sys.modules, name, None)  # a None entry makes the import raise ImportError
    assert dh.discover({}) == {}
    err = capsys.readouterr().out
    assert "not advertising tool.execute" in err and "not advertising yolo.prelabel" in err


def test_discover_advertises_both_when_weights_are_loaded(monkeypatch: pytest.MonkeyPatch, capsys):
    _fake_dental_agent(monkeypatch, model=object())
    handlers = dh.discover({"YOLO_MODEL_ID": "yolo-a"})
    assert set(handlers) == {"tool.execute", "yolo.prelabel"}
    assert "not advertising" not in capsys.readouterr().out


def test_discover_without_weights_advertises_tool_execute_but_not_yolo_and_says_why(monkeypatch: pytest.MonkeyPatch, capsys):
    _fake_dental_agent(monkeypatch, model=None)
    handlers = dh.discover({})
    assert set(handlers) == {"tool.execute"}
    out = capsys.readouterr().out
    assert "not advertising yolo.prelabel: grounding weights not found at data/models/missing/best.pt" in out
    assert "locate_tooth will fail" in out
