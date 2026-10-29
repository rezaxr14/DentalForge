"""`trace.render_artifacts`: re-execute a stored trace's tool calls and store the images (WP3).

A `torch_hf` run cannot hand out the images its tools produced (ADR-0025), and an imported trace
never carried them. This handler rebuilds them: it reads the trace's tool calls, runs each one on the
source image with the same dispatch the agent loops use, and uploads the results.

Two invariants:

  * **Same code path as the agent.** Execution goes through VLM-DENTAL's `execute_tool_call`, so a
    re-render cannot drift from what the model actually saw.
  * **Upload once per distinct image.** Re-execution is deterministic, so several turns can ask for the
    same crop; the bytes are hashed and each hash is uploaded exactly once, while every
    `(turnIdx, callIdx)` still appears in the result so the trace page keeps its ordering.

The same rendering is exposed offline as a CLI (`python render_artifacts.py --trace <file>`), which
WP7 uses to build the public demo assets without a worker or a job.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Sequence

from worker_errors import NonRetryable

# What a re-execution needs from a turn, normalized from either shape:
#   * the app's stored trace (camelCase, nested under `turns[].toolCalls`, from `GET /traces/{id}`);
#   * a research JSONL trace (`turn_calls` under `tool_calls_this_turn`, tool/args snake_case).
Call = tuple[int, int, str, dict[str, Any], bool]


def _png(image: Any) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def _args(value: Any) -> dict[str, Any]:
    """Tool arguments as the dispatch expects them: a dict, or a refusal (never a guess)."""
    if value is None:
        return {}
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError as e:
            raise NonRetryable(f"tool arguments are not JSON: {e}") from e
    if not isinstance(value, dict):
        raise NonRetryable(f"tool arguments must be an object, got {type(value).__name__}")
    return value


def calls_from_stored(trace: dict[str, Any]) -> Iterator[Call]:
    """`GET /traces/{id}` shape. Calls the run recorded as failed are kept but marked not-ok."""
    for turn in trace.get("turns") or []:
        if not isinstance(turn, dict):
            continue
        for call in turn.get("toolCalls") or []:
            if not isinstance(call, dict):
                continue
            yield (
                int(turn.get("idx", 0)),
                int(call.get("idx", 0)),
                str(call.get("toolName") or ""),
                _args(call.get("args")),
                bool(call.get("ok", True)),
            )


def calls_from_file(trace: dict[str, Any]) -> Iterator[Call]:
    """Research JSONL shape: `turns[].tool_calls_this_turn[]` with `tool_name`/`args`."""
    for turn_idx, turn in enumerate(trace.get("turns") or []):
        if not isinstance(turn, dict):
            continue
        for call_idx, call in enumerate(turn.get("tool_calls_this_turn") or []):
            if not isinstance(call, dict):
                continue
            name = call.get("tool_name") or call.get("name") or ""
            yield (
                int(turn.get("turn", turn_idx)),
                int(call.get("call_idx", call_idx)),
                str(name),
                _args(call.get("args")),
                bool(call.get("ok", True)),
            )


def render_calls(
    *,
    calls: Iterable[Call],
    image: Any,
    registry: Any,
    execute_tool_call: Callable[[Any, str, dict[str, Any], Any], Any],
    sink: Callable[[str, str, str, bytes], str],
    log: Callable[[dict[str, Any]], None] = lambda _d: None,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Run every call once per distinct output; return the refs and a small counter summary.

    `sink(name, mime, sha256, data)` stores the bytes and returns the id/name the caller wants back.
    A tool that returns data (a bbox, an FDI label) has nothing to render and is skipped silently;
    a tool that raised during the original run is reported, not retried into a second failure.
    """
    artifacts: list[dict[str, Any]] = []
    by_hash: dict[str, str] = {}
    counts = {"rendered": 0, "reused": 0, "skippedFailed": 0, "skippedData": 0, "failed": 0}
    for turn_idx, call_idx, tool, args, ok in calls:
        if not ok:
            counts["skippedFailed"] += 1
            log({"turnIdx": turn_idx, "callIdx": call_idx, "message": f"not re-executing failed call {tool!r}"})
            continue
        if not tool:
            counts["skippedFailed"] += 1
            log({"turnIdx": turn_idx, "callIdx": call_idx, "message": "tool call has no tool name"})
            continue
        try:
            out = execute_tool_call(registry, tool, args, image)
        except Exception as e:  # noqa: BLE001 - one broken call must not lose the rest of the trace
            counts["failed"] += 1
            log({"turnIdx": turn_idx, "callIdx": call_idx, "message": f"{tool} failed: {type(e).__name__}: {e}"})
            continue
        if not hasattr(out, "save") or not hasattr(out, "width"):
            counts["skippedData"] += 1
            continue
        data = _png(out)
        digest = hashlib.sha256(data).hexdigest()
        ref = by_hash.get(digest)
        if ref is None:
            ref = sink(f"{tool}_{turn_idx}_{call_idx}.png", "image/png", digest, data)
            by_hash[digest] = ref
            counts["rendered"] += 1
        else:
            counts["reused"] += 1
        # `sha256` is the dedupe key, not part of the contract: `TraceRenderArtifactsResult` is
        # `additionalProperties: false`, so putting it in the result makes /complete reject the job.
        artifacts.append({"turnIdx": turn_idx, "callIdx": call_idx, "artifactId": ref})
    return artifacts, counts


def make_render_artifacts(
    *,
    registry: Any,
    execute_tool_call: Callable[[Any, str, dict[str, Any], Any], Any],
    load_image: Callable[[Any, Any], Any],
) -> Callable[[Any], dict[str, Any]]:
    """Build the job handler. `artifactId` in the result is the synthetic reference `sink` returned."""

    def trace_render_artifacts(ctx: Any) -> dict[str, Any]:
        trace_id = ctx.job["payload"].get("traceId")
        if not trace_id:
            raise NonRetryable("payload.traceId is required")
        trace = ctx.client.get(f"/traces/{trace_id}")
        image_id = trace.get("imageId")
        if not image_id:
            raise NonRetryable(f"trace {trace_id} has no image; nothing to re-execute")

        image = load_image(ctx, image_id)

        def sink(name: str, mime: str, _sha: str, data: bytes) -> str:
            return ctx.upload(name, mime, data)

        def log(payload: dict[str, Any]) -> None:
            ctx.emit("log", payload)

        artifacts, counts = render_calls(
            calls=calls_from_stored(trace),
            image=image,
            registry=registry,
            execute_tool_call=execute_tool_call,
            sink=sink,
            log=log,
        )
        if not artifacts:
            raise NonRetryable(
                "no tool call produced an image: the trace has no image-returning calls, or all of them failed"
            )
        ctx.emit("progress", {"pct": 100, **counts, "artifacts": len(artifacts)})
        return {"artifacts": artifacts}

    return trace_render_artifacts


# --------------------------------------------------------------------------- CLI
def render_trace_file(
    *,
    trace_path: str | Path,
    image_path: str | Path,
    out_dir: str | Path,
    registry: Any,
    execute_tool_call: Callable[[Any, str, dict[str, Any], Any], Any],
) -> list[Path]:
    """Offline re-render: writes `<turn>_<call>_<tool>.png` per distinct output and returns the paths."""
    from PIL import Image

    trace = json.loads(Path(trace_path).read_text(encoding="utf-8"))
    if not isinstance(trace, dict):
        raise ValueError("trace file must contain a JSON object")
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    by_hash: dict[str, Path] = {}

    def sink(name: str, _mime: str, sha: str, data: bytes) -> str:
        path = by_hash.get(sha)
        if path is None:
            path = out / name
            path.write_bytes(data)
            by_hash[sha] = path
            written.append(path)
        return str(path)

    image = Image.open(image_path).convert("RGB")
    artifacts, counts = render_calls(
        calls=calls_from_file(trace),
        image=image,
        registry=registry,
        execute_tool_call=execute_tool_call,
        sink=sink,
        log=lambda d: print(f"[render] {d['message']}", file=sys.stderr, flush=True),
    )
    print(
        f"[render] {len(artifacts)} call(s): {counts['rendered']} image(s) written, "
        f"{counts['reused']} reused, {counts['skippedData']} data-only, "
        f"{counts['skippedFailed']} originally failed, {counts['failed']} failed now",
        flush=True,
    )
    return written


def _main(argv: Sequence[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--trace", required=True, help="trace JSON (research JSONL line or exported trace object)")
    parser.add_argument("--image", help="source image; defaults to the trace's image_path")
    parser.add_argument("--out", default="rendered", help="output directory (default: ./rendered)")
    args = parser.parse_args(argv)

    if not Path(args.trace).is_file():
        print(f"[render] no such trace file: {args.trace}", file=sys.stderr)
        return 2
    trace = json.loads(Path(args.trace).read_text(encoding="utf-8"))
    image_path = args.image or (trace.get("image_path") if isinstance(trace, dict) else None)
    if not image_path:
        print("[render] the trace has no image_path; pass --image", file=sys.stderr)
        return 2
    if not Path(image_path).is_file():
        print(f"[render] no such image: {image_path}", file=sys.stderr)
        return 2
    try:
        from dental_agent.agent.tool_dispatch import execute_tool_call
        from dental_agent.tools.registry import ToolRegistry
    except ImportError as e:
        print(f"[render] dental_agent is not importable: {e}", file=sys.stderr)
        return 2

    written = render_trace_file(
        trace_path=args.trace,
        image_path=image_path,
        out_dir=args.out,
        registry=ToolRegistry.create_default(),
        execute_tool_call=execute_tool_call,
    )
    for path in written:
        print(path)
    return 0 if written else 1


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
