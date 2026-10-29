"""Real handlers for the reference worker, backed by VLM-DENTAL's `dental_agent` package.

Optional by design. `discover()` advertises a job type ONLY when what it needs is actually
present, and reports why it skipped the others, so the app's capability ladder never routes
work this worker cannot do:

    tool.execute   needs `dental_agent` importable (the 8-tool registry).
                   `locate_tooth` additionally needs the YOLO grounding weights; without them
                   that one tool fails the job (non-retryable) instead of returning a fake box.
    trace.render_artifacts
                   same prerequisites as `tool.execute`: it re-executes the calls a stored trace
                   recorded through the same registry, no torch.
    yolo.prelabel  needs `ultralytics` and the grounding weights to be loaded.
    al.score       same detector as `yolo.prelabel` (it scores its confidences).

`agent.run` and `eval.run` are wired by `worker.py` when a model backend is available;
`parity.golden` is deliberately a dev CLI, not a job (ADR-0025).

Install the research package next to this worker, e.g. `pip install -e ../../../VLM-DENTAL`
or `export PYTHONPATH=/path/to/VLM-DENTAL`.

Env: YOLO_MODEL_ID — the registered model id this worker's weights correspond to. If set, a
`yolo.prelabel` job for any other modelId is refused (non-retryable) instead of being answered
with the wrong model's boxes. If unset the worker answers any modelId and echoes it back.
"""
from __future__ import annotations

import io
import os
import re
import time
from typing import TYPE_CHECKING, Any, Callable

from worker_errors import ContractError, NonRetryable

if TYPE_CHECKING:  # type hints only: importing worker here would load worker.py twice when run as a script
    from worker import JobContext

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
MAX_IMAGE_BYTES = 64 * 1024 * 1024
IMAGE_CACHE_SIZE = 2  # consecutive tool.execute jobs of one agent run hit the same image


class ImageSource:
    """Fetches an image's native pixels through the contract (`GET /images/{id}` -> signed URL)."""

    def __init__(self, cache_size: int = IMAGE_CACHE_SIZE):
        self._cache: dict[str, Any] = {}
        self._order: list[str] = []
        self._size = cache_size

    def __call__(self, ctx: JobContext, image_id: Any) -> Any:
        from PIL import Image

        key = str(image_id)
        # The image endpoint addresses images by UUID; the payload schema also allows integers
        # (research-repo ids), which this worker cannot resolve.
        if not UUID_RE.match(key):
            raise NonRetryable(f"imageId {key!r} is not a TraceForge image UUID; cannot fetch its pixels")
        if key in self._cache:
            return self._cache[key]

        try:
            meta = ctx.client.get(f"/images/{key}")
        except ContractError as e:
            if e.status == 404:
                raise NonRetryable(f"image {key} not found") from e
            raise
        resp = ctx.client.http.get(meta["url"])  # signed URL: no bearer header
        if not resp.is_success:
            raise RuntimeError(f"image download -> HTTP {resp.status_code}")
        if len(resp.content) > MAX_IMAGE_BYTES:
            raise NonRetryable(f"image is {len(resp.content)} bytes; limit is {MAX_IMAGE_BYTES}")
        image = Image.open(io.BytesIO(resp.content)).convert("RGB")
        # Boxes are in NATIVE pixels (contract). If the stored size and the decoded size disagree,
        # every coordinate this worker returns would be in the wrong space: refuse loudly.
        if (image.width, image.height) != (meta["width"], meta["height"]):
            raise NonRetryable(
                f"image {key}: stored size {meta['width']}x{meta['height']} != decoded {image.width}x{image.height}"
            )

        self._cache[key] = image
        self._order.append(key)
        while len(self._order) > self._size:
            self._cache.pop(self._order.pop(0), None)
        return image


def _png(image: Any) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def make_tool_execute(
    *,
    registry: Any,
    execute_tool_call: Callable[[Any, str, dict[str, Any], Any], Any],
    to_canonical: Callable[[Any, str], Any],
    family_for_tool: Callable[[str], str],
    load_image: Callable[[JobContext, Any], Any],
    grounding_ready: Callable[[], bool] = lambda: True,
) -> Callable[[JobContext], dict[str, Any]]:
    """`tool.execute`: run ONE agent tool on the NATIVE image, exactly as the agent loops do.

    `execute_tool_call` is VLM-DENTAL's shared dispatch (which tools take the source image), so this
    worker cannot drift from the calling convention SFT and GRPO use. Tools that return an image are
    uploaded as a PNG artifact; everything else (locate_tooth, nudge_crop, fdi_label) is returned as
    data. `view: "canonical"` resamples only the RENDERED output, like SFT does; tools still execute
    on the native image.
    """

    def tool_execute(ctx: JobContext) -> dict[str, Any]:
        from PIL import Image

        p = ctx.job["payload"]
        tool, args, view = p["tool"], p.get("args") or {}, p.get("view", "native")
        if not isinstance(args, dict):
            raise NonRetryable("args must be an object")
        if registry.get(tool) is None:
            raise NonRetryable(f"tool {tool!r} is not registered on this worker")
        if tool == "locate_tooth" and not grounding_ready():
            raise NonRetryable("locate_tooth needs the YOLO grounding weights, which this worker has not loaded")

        image = load_image(ctx, p["imageId"])
        t0 = time.perf_counter()
        try:
            out = execute_tool_call(registry, tool, args, image)
        except Exception as e:  # noqa: BLE001 - identical arguments will fail identically
            raise NonRetryable(f"{tool} failed: {type(e).__name__}: {e}") from e
        duration_ms = round((time.perf_counter() - t0) * 1000, 1)

        if isinstance(out, Image.Image):
            if view == "canonical":
                out = to_canonical(out, family_for_tool(tool))
            artifact_id = ctx.upload(f"{tool}_{str(p['imageId'])[:8]}.png", "image/png", _png(out))
            return {"kind": "image", "artifactId": artifact_id, "width": out.width, "height": out.height,
                    "durationMs": duration_ms}
        # Tool-level answers such as {"error": "Tooth 38 not found"} are RESULTS the agent must see,
        # not job failures, so they are returned as data.
        return {"kind": "data", "data": out, "durationMs": duration_ms}

    return tool_execute


def detect_boxes(model: Any, image: Any, conf: float) -> tuple[list[dict[str, Any]], float]:
    """Every detection above `conf`, in NATIVE pixels, with FDI numbers. Returns (boxes, inference_ms).

    classIdx = (quadrant-1)*8 + (position-1), the mapping the model was trained with (and
    `locate_tooth` inverts). Shared by `yolo.prelabel` and `al.score` so both read the same head.
    """
    t0 = time.perf_counter()
    results = model.predict(image, verbose=False, conf=conf)
    inference_ms = round((time.perf_counter() - t0) * 1000, 1)
    if not results:
        raise RuntimeError("model returned no result object")

    boxes = results[0].boxes
    classes, confs, xywh = boxes.cls.tolist(), boxes.conf.tolist(), boxes.xywh.tolist()
    out = []
    for cls, c, (cx, cy, w, h) in zip(classes, confs, xywh):
        idx = int(cls)
        if not 0 <= idx <= 31:
            # Never drop a detection silently: a class outside the 32 FDI positions means these are
            # not the dental grounding weights this contract describes.
            raise NonRetryable(f"model produced class index {idx}; expected 0-31 (32 FDI tooth classes)")
        # Clip BOTH edges to the image (cut the box, never shift it).
        x0, y0 = max(0.0, cx - w / 2), max(0.0, cy - h / 2)
        x1, y1 = min(float(image.width), cx + w / 2), min(float(image.height), cy + h / 2)
        out.append({
            "bbox": [round(x0, 1), round(y0, 1), round(max(0.0, x1 - x0), 1), round(max(0.0, y1 - y0), 1)],
            "conf": round(min(max(float(c), 0.0), 1.0), 4),
            "classIdx": idx,
            "fdiQuadrant": idx // 8 + 1,
            "fdiPosition": idx % 8 + 1,
        })
    out.sort(key=lambda b: -b["conf"])
    return out, inference_ms


def make_yolo_prelabel(
    *,
    get_model: Callable[[], Any],
    load_image: Callable[[JobContext, Any], Any],
    served_model_id: str | None = None,
) -> Callable[[JobContext], dict[str, Any]]:
    """`yolo.prelabel`: every detection above `confThreshold`, in NATIVE pixels, with FDI numbers.

    `locate_tooth` returns ONE padded box for ONE tooth; pre-labelling needs all raw boxes, so this
    calls the model directly. classIdx = (quadrant-1)*8 + (position-1), the mapping the model was
    trained with (and `locate_tooth` inverts).
    """

    def yolo_prelabel(ctx: JobContext) -> dict[str, Any]:
        p = ctx.job["payload"]
        model_id, conf = p["modelId"], float(p.get("confThreshold", 0.25))
        if served_model_id and model_id != served_model_id:
            raise NonRetryable(f"this worker serves model {served_model_id!r}, not {model_id!r}")
        if not 0.0 <= conf <= 1.0:
            raise NonRetryable(f"confThreshold {conf} is outside [0, 1]")

        image = load_image(ctx, p["imageId"])
        model = get_model()
        out, inference_ms = detect_boxes(model, image, conf)
        return {"modelId": model_id, "inferenceMs": inference_ms, "boxes": out}

    return yolo_prelabel


def discover(env: dict[str, str] | None = None) -> dict[str, Callable[[JobContext], dict[str, Any]]]:
    """Handlers whose prerequisites are present. Prints what was enabled and why the rest were not."""
    env = os.environ if env is None else env
    handlers: dict[str, Callable[[JobContext], dict[str, Any]]] = {}
    skipped: dict[str, str] = {}
    load_image = ImageSource()

    grounder = None
    grounder_reason = ""
    try:
        from dental_agent.tools.grounding import ToothGrounder

        grounder = ToothGrounder.get_instance()  # loads (or fetches) the weights once
        if grounder.model is None:
            grounder_reason = f"grounding weights not found at {grounder.model_path}"
    except ImportError as e:
        grounder_reason = f"{e}"
    except Exception as e:  # noqa: BLE001 - a broken weights file must not take the worker down
        grounder_reason = f"grounding model failed to load: {e}"
    grounding_loaded = grounder is not None and grounder.model is not None

    try:
        from dental_agent.agent.tool_dispatch import execute_tool_call
        from dental_agent.tools.registry import ToolRegistry
        from dental_agent.utils.canonical import family_for_tool, to_canonical

        handlers["tool.execute"] = make_tool_execute(
            registry=ToolRegistry.create_default(),
            execute_tool_call=execute_tool_call,
            to_canonical=to_canonical,
            family_for_tool=family_for_tool,
            load_image=load_image,
            grounding_ready=lambda: grounding_loaded,
        )
        # Same prerequisites as tool.execute: it re-executes the tools the trace recorded (WP3).
        import render_artifacts

        handlers["trace.render_artifacts"] = render_artifacts.make_render_artifacts(
            registry=ToolRegistry.create_default(),
            execute_tool_call=execute_tool_call,
            load_image=load_image,
        )
        if not grounding_loaded:
            print(f"[worker] note: tool.execute is advertised but locate_tooth will fail ({grounder_reason})", flush=True)
    except ImportError as e:
        skipped["tool.execute"] = f"dental_agent not importable: {e}"

    if grounding_loaded:
        served = env.get("YOLO_MODEL_ID") or None
        handlers["yolo.prelabel"] = make_yolo_prelabel(
            get_model=lambda: grounder.model, load_image=load_image, served_model_id=served
        )
        import al_score

        handlers["al.score"] = al_score.make_al_score(
            detect=lambda image, conf: detect_boxes(grounder.model, image, conf),
            load_image=load_image,
            served_model_id=served,
        )
        if not served:
            print("[worker] note: YOLO_MODEL_ID unset; yolo.prelabel and al.score answer any modelId and echo it", flush=True)
    else:
        skipped["yolo.prelabel"] = grounder_reason or "grounding model not loaded"

    for job, why in skipped.items():
        print(f"[worker] not advertising {job}: {why}", flush=True)
    return handlers
