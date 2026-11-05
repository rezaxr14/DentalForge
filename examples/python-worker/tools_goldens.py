#!/usr/bin/env python3
"""Golden generator/checker for the eight VLM-DENTAL tools (ADR-0024).

The compatibility contract (`tests/python/test_compat_contract.py`) runs every tool on the three
tracked sample images and compares the results with `fixtures/goldens/vlm_tools.json`. A mismatch is
a **drift report**, not an automatic bug: VLM-DENTAL changed, or a numeric library changed. Goldens
are regenerated only by the owner's decision.

    python examples/python-worker/tools_goldens.py            # print the current report
    python examples/python-worker/tools_goldens.py --check    # diff against the stored golden
    python examples/python-worker/tools_goldens.py --write    # regenerate (owner decision only)

Exit codes: 0 match / written, 1 drift (with a readable diff), 2 no checkout or sample images.
Read-only: the checkout is imported, never modified (bytecode writing is disabled).
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True

import vlm_compat  # noqa: E402 - same directory; also disables bytecode writing

ADAPTER_VERSION = "vlm-tools.v1"
REPO_ROOT = Path(__file__).resolve().parents[2]
GOLDEN_PATH = REPO_ROOT / "fixtures" / "goldens" / "vlm_tools.json"
SAMPLE_DIR = Path("data") / "sample_images" / "validation_data" / "quadrant_enumeration_disease" / "xrays"
SAMPLE_IMAGES = ("val_18.png", "val_32.png", "val_44.png")

# Model inference (YOLO) is environment-sensitive: a different torch/ultralytics build moves boxes by
# a few pixels without any upstream drift. These tools are compared only on the environment recorded
# in the golden; the deterministic tools are compared everywhere.
MODEL_TOOLS = ("locate_tooth",)
FINGERPRINT_PACKAGES = ("torch", "ultralytics", "transformers", "pillow", "numpy", "opencv-python-headless")


def environment(report: dict[str, Any]) -> dict[str, Any]:
    """Package fingerprint: the golden's model numbers are only comparable on the same stack."""
    from importlib.metadata import PackageNotFoundError, version

    versions: dict[str, str | None] = {}
    known = report.get("packages") or {}
    for name in FINGERPRINT_PACKAGES:
        if name in known:
            versions[name] = known[name]
            continue
        try:
            versions[name] = version(name)
        except PackageNotFoundError:
            versions[name] = None
    return {"python": report.get("python"), "packages": versions}


def _round(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 4)
    if isinstance(value, dict):
        return {k: _round(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_round(v) for v in value]
    return value


def describe(output: Any) -> dict[str, Any]:
    """A stable, comparable description of a tool result (images by size + raw-pixel hash)."""
    from PIL import Image

    if isinstance(output, Image.Image):
        return {
            "kind": "image",
            "size": [output.width, output.height],
            "mode": output.mode,
            "pixelsSha256": hashlib.sha256(output.tobytes()).hexdigest(),
        }
    if isinstance(output, dict):
        return {"kind": "data", "data": _round(output)}
    return {"kind": "data", "data": _round(output)}


def tool_cases(width: int, height: int) -> list[tuple[str, dict[str, Any]]]:
    """Fixed, deterministic arguments per tool: same inputs every run, for every image."""
    box = [round(width * 0.25, 1), round(height * 0.2, 1), round(width * 0.3, 1), round(height * 0.3, 1)]
    mirror = [round(width * 0.3, 1), round(height * 0.3, 1), round(width * 0.2, 1), round(height * 0.2, 1)]
    return [
        ("zoom_crop", {"bbox": box, "padding_frac": 0.25}),
        ("window_level", {"preset": "bone"}),
        ("locate_tooth", {"tooth": 38}),
        ("fdi_label", {"quadrant": 3, "tooth_position": 8}),
        ("denoise", {"method": "bilateral", "strength": 0.6}),
        ("contralateral_compare", {"bbox": mirror, "quadrant": 1}),
        ("enhance_contrast", {"factor": 1.5}),
        ("nudge_crop", {"bbox": box, "dx_frac": 0.05, "dy_frac": -0.05, "scale": 1.1}),
    ]


def collect(path: str | Path | None = None, include_grounding: bool | None = None) -> dict[str, Any]:
    """Run every tool on every sample image. Raises RuntimeError with a precise reason on failure.

    `include_grounding=None` decides from the probe: a torch-free (light) install runs the seven
    non-grounding tools and records `locate_tooth` as skipped, so the same contract test works in the
    weekly light CI job.
    """
    report = vlm_compat.probe(path)
    if not report.get("path"):
        raise RuntimeError(f"no VLM-DENTAL checkout: {report.get('importError')}")
    if include_grounding is None:
        include_grounding = bool(report.get("jobs", {}).get("yolo.prelabel", {}).get("available"))

    from PIL import Image

    from dental_agent.agent.tool_dispatch import execute_tool_call
    from dental_agent.tools.registry import ToolRegistry

    checkout = Path(report["path"])
    images_dir = checkout / SAMPLE_DIR
    registry = ToolRegistry.create_default()

    out: dict[str, Any] = {
        "adapter": ADAPTER_VERSION,
        "vlmDental": report["provenance"],  # provenance only: never compared
        "environment": environment(report),
        "images": {},
        "tools": {},
        "skipped": [] if include_grounding else ["locate_tooth"],
    }
    for name in SAMPLE_IMAGES:
        image_path = images_dir / name
        if not image_path.is_file():
            raise RuntimeError(f"sample image missing: {image_path}")
        raw = image_path.read_bytes()
        image = Image.open(image_path).convert("RGB")
        out["images"][name] = {
            "size": [image.width, image.height],
            "fileSha256": hashlib.sha256(raw).hexdigest(),
        }
        cases = [
            (tool, args)
            for tool, args in tool_cases(image.width, image.height)
            if include_grounding or tool != "locate_tooth"
        ]
        out["tools"][name] = {
            tool: describe(execute_tool_call(registry, tool, args, image)) for tool, args in cases
        }
    return out


def diff(golden: dict[str, Any], current: dict[str, Any], ignore: tuple[str, ...] = ()) -> list[str]:
    """Human-readable drift lines: which image, which tool, which numbers changed."""
    lines: list[str] = []
    skipped = set(current.get("skipped") or []) | set(ignore)
    for name, entry in (golden.get("images") or {}).items():
        now = (current.get("images") or {}).get(name)
        if now is None:
            lines.append(f"{name}: image is missing from the current run")
        elif now != entry:
            lines.append(f"{name}: sample image changed (size/fileSha256)")
    for name, tools in (golden.get("tools") or {}).items():
        now_tools = (current.get("tools") or {}).get(name) or {}
        for tool, expected in tools.items():
            if tool in skipped:
                continue
            got = now_tools.get(tool)
            if got is None:
                lines.append(f"{name}/{tool}: not produced by the current run")
            elif got != expected:
                lines.append(f"{name}/{tool}: changed\n    expected: {json.dumps(expected, sort_keys=True)}"
                             f"\n    got:      {json.dumps(got, sort_keys=True)}")
    for name in (current.get("tools") or {}):
        if name not in (golden.get("tools") or {}):
            lines.append(f"{name}: new sample image not present in the golden")
    return lines


def _main(argv: list[str]) -> int:
    try:
        current = collect()
    except Exception as e:  # noqa: BLE001 - a missing checkout/images is exit 2, not a traceback
        print(f"[goldens] cannot collect: {type(e).__name__}: {e}", file=sys.stderr)
        return 2

    if "--write" in argv:
        if current.get("skipped"):
            print(
                f"[goldens] refusing to write a partial golden: skipped {', '.join(current['skipped'])}"
                " (run where the grounding runtime is available)",
                file=sys.stderr,
            )
            return 2
        GOLDEN_PATH.parent.mkdir(parents=True, exist_ok=True)
        GOLDEN_PATH.write_text(json.dumps(current, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"[goldens] wrote {GOLDEN_PATH}")
        return 0
    if "--check" in argv:
        if not GOLDEN_PATH.is_file():
            print(f"[goldens] no golden at {GOLDEN_PATH}; run --write once (owner decision)", file=sys.stderr)
            return 2
        golden = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
        same_env = golden.get("environment") == current.get("environment")
        drift = diff(golden, current, ignore=() if same_env else MODEL_TOOLS)
        if not same_env:
            print(
                "[goldens] note: this environment differs from the recorded one, so "
                f"{', '.join(MODEL_TOOLS)} is not compared (deterministic tools still are)"
            )
        if drift:
            print("[goldens] DRIFT (report, not an automatic bug):")
            for line in drift:
                print("  " + line)
            return 1
        per_image = len(next(iter(current["tools"].values()), {}))
        skipped = f"; skipped: {', '.join(current['skipped'])}" if current.get("skipped") else ""
        print(f"[goldens] match ({len(SAMPLE_IMAGES)} images x {per_image} tools{skipped})")
        return 0
    print(json.dumps(current, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
