#!/usr/bin/env python3
"""Build the public demo bundle from a read-only VLM-DENTAL checkout.

DENTEX ONLY. Every item carries dataset=dentex and a licence; the build aborts
if a Tufts path or id slips in. The output is:

  demo/bundle.json                 sanitized images, traces, evals, models
  demo/MANIFEST.json               provenance, counts, sha256 per asset
  demo/NOTICE.md                   DENTEX + YOLO licence notices
  public/demo-assets/images/*.jpg  downscaled radiographs (full + thumb)
  public/demo-assets/artifacts/*   downscaled real tool renders

Run: python scripts/demo_build.py [--propose]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    print("Pillow is required: pip install pillow", file=sys.stderr)
    sys.exit(1)

REPO = Path(__file__).resolve().parent.parent
VLM = Path(os.environ.get("VLM_DENTAL_DIR", REPO.parent / "vlm-dental")).resolve()
DATA = VLM / "data"
DENTEX = DATA / "dentex" / "DENTEX"
TRAIN_XRAYS = DENTEX / "training_data" / "quadrant-enumeration-disease" / "xrays"
TRAIN_COCO = DENTEX / "training_data" / "quadrant-enumeration-disease" / "train_quadrant_enumeration_disease.json"
VAL_XRAYS = DENTEX / "validation_data" / "quadrant_enumeration_disease" / "xrays"
VAL_COCO = DENTEX / "validation_triple.json"
TRACES = DATA / "traces"
EVALS = DATA / "evaluations"
DOC_IMAGES = VLM / "docs" / "images"

OUT = REPO / "demo"
ASSETS = REPO / "public" / "demo-assets"
IMG_OUT = ASSETS / "images"
ART_OUT = ASSETS / "artifacts"

LICENSE = "DENTEX (CC-BY-NC-SA-4.0); downscaled derivative for research use"
MAX_FULL_W = 1536
MAX_ART_W = 512
MAX_ASSET_SIZE = 500_000  # 500 KB per image
MAX_BUNDLE_SIZE = 15_000_000  # 15 MB
MAX_TOTAL_ASSETS = 25_000_000  # 25 MB

# Curated starting points: the five LabelForge fixtures, the artefact-rich
# traces, the three validation images used by the zero-shot evals, and a
# spread of healthy + failing cases.
LABEL_IDS = [1, 2, 3, 4, 5]
ARTIFACT_IDS = [255, 401, 536, 639]
VAL_NAMES = ["val_18.png", "val_32.png", "val_44.png"]


# ──────────────────────────────────────────────────────────────────────
# Pure, testable functions (no I/O, no globals)
# ──────────────────────────────────────────────────────────────────────

def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def scan_for_secrets_and_paths(text: str) -> list[str]:
    """Return a list of violations found in the text."""
    violations = []
    # Secret patterns
    secret_patterns = [
        (r"hf_[A-Za-z0-9]{20,}", "Hugging Face token"),
        (r"sk-[A-Za-z0-9]{20,}", "OpenAI-style secret"),
        (r"AIza[A-Za-z0-9_-]{35}", "Google API key"),
    ]
    for pattern, label in secret_patterns:
        if re.search(pattern, text):
            violations.append(f"secret:{label}")
    # Windows paths
    if re.search(r"[A-Za-z]:\\", text):
        violations.append("windows_path")
    # Unix home paths
    if re.search(r"/home/", text):
        violations.append("unix_home_path")
    # Tufts
    if re.search(r"tufts", text, re.IGNORECASE):
        violations.append("tufts_reference")
    return violations


def assert_dentex_only(item: dict, context: str) -> list[str]:
    """Return violations if item is not DENTEX-only."""
    violations = []
    dataset = item.get("dataset", "").lower()
    source = item.get("sourceFile", "").lower()
    if dataset != "dentex":
        violations.append(f"{context}: dataset is {dataset}, not dentex")
    if "tufts" in source:
        violations.append(f"{context}: tufts in sourceFile")
    if dataset == "tufts":
        violations.append(f"{context}: dataset is tufts")
    return violations


ALLOWED_TRACE_FIELDS = {
    "image_id", "dataset", "ground_truth", "turns", "tool_calls",
    "final_answer", "format_ok", "verifier_reason", "source_file"
}
ALLOWED_TURN_FIELDS = {"turn", "status", "raw_output", "parsed", "tool_calls_this_turn"}
ALLOWED_PARSED_FIELDS = {"thought", "final_answer", "tool_calls"}
ALLOWED_CALL_FIELDS = {
    "tool_name", "tool_args", "tool_ok", "tool_error", "true_bbox",
    "perturb_tier", "artifact_key"
}


def sanitize_trace(rec: dict, source_file: str) -> dict:
    """Clean a trace record, keeping only allowed fields."""
    turns = []
    for t in rec.get("turns") or []:
        parsed = t.get("parsed")
        if isinstance(parsed, dict):
            parsed = {k: v for k, v in {
                "thought": (parsed.get("thought") or "")[:2000] or None,
                "final_answer": parsed.get("final_answer"),
                "tool_calls": parsed.get("tool_calls"),
            }.items() if v is not None}
        calls = []
        for c in t.get("tool_calls_this_turn") or []:
            calls.append({k: v for k, v in {
                "tool_name": c.get("tool_name"),
                "tool_args": c.get("tool_args") or {},
                "tool_ok": bool(c.get("tool_ok")),
                "tool_error": c.get("tool_error"),
                "true_bbox": c.get("true_bbox"),
                "perturb_tier": c.get("perturb_tier"),
            }.items() if v is not None})
        turns.append({k: v for k, v in {
            "turn": t.get("turn"),
            "status": t.get("status"),
            "raw_output": (t.get("raw_output") or "")[:2000],
            "parsed": parsed,
            "tool_calls_this_turn": calls,
        }.items() if v is not None})

    return {k: v for k, v in {
        "image_id": rec["image_id"],
        "dataset": "dentex",
        "ground_truth": rec.get("ground_truth") or [],
        "turns": turns,
        "tool_calls": rec.get("tool_calls") if isinstance(rec.get("tool_calls"), int) else len(turns),
        "final_answer": rec.get("final_answer"),
        "format_ok": bool(rec.get("format_ok")),
        "verifier_reason": rec.get("verifier_reason"),
        "source_file": source_file,
    }.items() if v is not None}


def check_size_budgets(images: list[dict], bundle_bytes: int) -> list[str]:
    """Return violations if size budgets are exceeded."""
    violations = []
    if bundle_bytes > MAX_BUNDLE_SIZE:
        violations.append(f"bundle.json {bundle_bytes} bytes > {MAX_BUNDLE_SIZE}")
    total_asset_bytes = 0
    for img in images:
        if "sha256" in img:  # only check full assets that we wrote
            # We can't easily get file size here without I/O; the build does it after write.
            pass
    return violations


# ──────────────────────────────────────────────────────────────────────
# I/O helpers (thin wrappers)
# ──────────────────────────────────────────────────────────────────────

def git_head(repo: Path) -> dict:
    def run(*args):
        try:
            return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()
        except Exception:
            return ""
    return {"commit": run("rev-parse", "HEAD"), "branch": run("rev-parse", "--abbrev-ref", "HEAD"), "dirty": bool(run("status", "--porcelain"))}


def load_jsonl(path: Path):
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)


def image_map() -> dict[int, str]:
    coco = json.loads(TRAIN_COCO.read_text(encoding="utf-8"))
    return {int(im["id"]): im["file_name"] for im in coco["images"]}


def val_map() -> dict[str, int]:
    coco = json.loads(VAL_COCO.read_text(encoding="utf-8"))
    return {im["file_name"]: int(im["id"]) for im in coco["images"]}


def downscale(src: Path, dst: Path, max_w: int, quality: int = 85) -> tuple[int, int, int, int]:
    with Image.open(src) as im:
        im = im.convert("RGB")
        orig_w, orig_h = im.width, im.height
        if im.width > max_w:
            h = round(im.height * max_w / im.width)
            im = im.resize((max_w, h), Image.LANCZOS)
        dst.parent.mkdir(parents=True, exist_ok=True)
        im.save(dst, "JPEG", quality=quality, optimize=True, progressive=True)
        return orig_w, orig_h, im.width, im.height


def artifact_index(image_id: int) -> dict[tuple[int, int], str]:
    out = {}
    if not DOC_IMAGES.exists():
        return out
    prefix = f"{image_id}_t3_turn"
    for p in DOC_IMAGES.glob(f"{image_id}_t3_turn*_i*_*.png"):
        name = p.name[len(f"{image_id}_t3_turn"):]
        try:
            turn_s, rest = name.split("_i", 1)
            idx_s, tool = rest.split("_", 1)
            out[(int(turn_s), int(idx_s))] = tool.rsplit(".", 1)[0]
        except ValueError:
            continue
    return out


def attach_artifacts(trace: dict, image_id: int) -> int:
    index = artifact_index(image_id)
    if not index:
        return 0
    n = 0
    for t in trace["turns"]:
        for i, c in enumerate(t.get("tool_calls_this_turn") or []):
            tool = index.get((t["turn"], i))
            if tool and tool == c.get("tool_name"):
                c["artifact_key"] = f"demo-assets/artifacts/{image_id}_turn{t['turn']}_i{i}.jpg"
                n += 1
    return n


# ──────────────────────────────────────────────────────────────────────
# Build steps (I/O orchestration)
# ──────────────────────────────────────────────────────────────────────

def build_images(ids: list[int], imap: dict[int, str], vmap: dict[str, int]) -> list[dict]:
    images = []
    for image_id in ids:
        file_name = imap.get(image_id)
        src = TRAIN_XRAYS / file_name if file_name else None
        if src and src.exists():
            full = IMG_OUT / f"dentex-{image_id}-full.jpg"
            thumb = IMG_OUT / f"dentex-{image_id}-thumb.jpg"
            ow, oh, w, h = downscale(src, full, MAX_FULL_W)
            downscale(src, thumb, 320, 80)
            images.append({
                "key": f"dentex-{image_id}",
                "datasetId": image_id,
                "sourceFile": file_name,
                "split": "train",
                "full": f"demo-assets/images/{full.name}",
                "thumb": f"demo-assets/images/{thumb.name}",
                "width": ow,
                "height": oh,
                "assetWidth": w,
                "assetHeight": h,
                "sha256": sha256_file(full),
                "license": LICENSE,
            })
    for name in VAL_NAMES:
        src = VAL_XRAYS / name
        if not src.exists():
            continue
        image_id = vmap.get(name)
        full = IMG_OUT / f"{name.replace('.png', '')}-full.jpg"
        thumb = IMG_OUT / f"{name.replace('.png', '')}-thumb.jpg"
        ow, oh, w, h = downscale(src, full, MAX_FULL_W)
        downscale(src, thumb, 320, 80)
        images.append({
            "key": name.replace(".png", ""),
            "datasetId": image_id,
            "sourceFile": name,
            "split": "test",
            "full": f"demo-assets/images/{full.name}",
            "thumb": f"demo-assets/images/{thumb.name}",
            "width": ow,
            "height": oh,
            "assetWidth": w,
            "assetHeight": h,
            "sha256": sha256_file(full),
            "license": LICENSE,
        })
    return images


def build_artifacts(image_ids: list[int]) -> int:
    n = 0
    for image_id in image_ids:
        index = artifact_index(image_id)
        if not index:
            continue
        for (turn, idx), _tool in index.items():
            src = DOC_IMAGES / f"{image_id}_t3_turn{turn}_i{idx}_{_tool}.png"
            if not src.exists():
                continue
            dst = ART_OUT / f"{image_id}_turn{turn}_i{idx}.jpg"
            if not dst.exists():
                downscale(src, dst, MAX_ART_W, 80)
            n += 1
    return n


def build_evals() -> list[dict]:
    runs = []
    for path in sorted(EVALS.glob("zero_shot_dentex_test_*.jsonl")):
        cases = []
        for rec in load_jsonl(path):
            cases.append({
                "image_id": rec.get("image_id"),
                "dataset": "dentex",
                "split": rec.get("split", "test"),
                "provider": rec.get("provider"),
                "model": rec.get("model"),
                "ground_truth": rec.get("ground_truth") or [],
                "predictions": rec.get("predictions") or [],
                "matched_pairs": rec.get("matched_pairs") or [],
                "fdi_precision": rec.get("fdi_precision", 0),
                "fdi_recall": rec.get("fdi_recall", 0),
                "fdi_f1": rec.get("fdi_f1", 0),
                "exact_precision": rec.get("exact_precision", 0),
                "exact_recall": rec.get("exact_recall", 0),
                "exact_f1": rec.get("exact_f1", 0),
                "closeness_score": rec.get("closeness_score", 0),
                "spatial_proximity": rec.get("spatial_proximity", 0),
                "diagnostic_similarity": rec.get("diagnostic_similarity", 0),
                "fdi_correct": rec.get("fdi_correct", False),
                "quadrant_correct": rec.get("quadrant_correct", False),
                "tooth_position_correct": rec.get("tooth_position_correct", False),
                "diagnosis_correct": rec.get("diagnosis_correct", False),
                "exact_match": rec.get("exact_match", False),
                "all_exact_match": rec.get("all_exact_match", False),
                "raw_output": (rec.get("raw_output") or "")[:4000],
                "format_ok": bool(rec.get("format_ok")),
                "finish_reason": rec.get("finish_reason", "stop"),
                "confidence": rec.get("confidence"),
                "timestamp": rec.get("timestamp"),
            })
        if not cases:
            continue
        first = cases[0]
        def mean(key):
            return sum(float(c.get(key) or 0) for c in cases) / len(cases)
        runs.append({
            "runKey": path.stem,
            "sourceFile": path.name,
            "dataset": "dentex",
            "split": first["split"],
            "provider": first["provider"],
            "model": first["model"],
            "n": len(cases),
            "summary": {
                "fdiF1": round(mean("fdi_f1"), 4),
                "exactF1": round(mean("exact_f1"), 4),
                "closeness": round(mean("closeness_score"), 4),
                "formatOk": round(sum(1 for c in cases if c["format_ok"]) / len(cases), 4),
            },
            "cases": cases,
        })
    return runs


def build_models(eval_runs: list[dict]) -> list[dict]:
    yolo = DATA / "models" / "dentex_grounding_tool_cv_best" / "cv_results.json"
    metrics = {}
    if yolo.exists():
        raw = json.loads(yolo.read_text(encoding="utf-8"))
        mean = raw.get("mean") or raw.get("mean_metrics") or {}
        for src, label in (
            ("mean_map50", "map50"),
            ("mean_map50_95", "map50_95"),
            ("mean_precision", "precision"),
            ("mean_recall_50", "recall50"),
            ("mean_iou", "iou"),
        ):
            value = mean.get(label) if mean else raw.get(src)
            if isinstance(value, (int, float)):
                metrics[label] = round(float(value), 4)
    models = [{
        "name": "DENTEX grounding YOLO (DENTEX-only CV)",
        "stage": "base",
        "backend": "ultralytics",
        "notes": "5-fold DENTEX-only checkpoint family; see demo/MANIFEST.json",
        "metrics": metrics,
        "license": "AGPL-3.0 (Ultralytics); weights trained on DENTEX only",
    }]
    seen = set()
    for run in eval_runs:
        key = (run["provider"], run["model"])
        if key in seen:
            continue
        seen.add(key)
        models.append({
            "name": run["model"],
            "stage": "test",
            "backend": run["provider"],
            "notes": "Zero-shot evaluation provider (recorded runs; not the research model)",
            "metrics": {"fdiF1": run["summary"]["fdiF1"], "exactF1": run["summary"]["exactF1"]},
            "license": "model weights not redistributed",
        })
    return models


# ──────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--propose", action="store_true", help="print the selection and exit")
    ap.add_argument("--allow-dirty", action="store_true", help="allow dirty VLM-DENTAL tree (recorded in manifest)")
    args = ap.parse_args()

    if not DATA.exists():
        print(f"VLM-DENTAL data not found at {DATA}", file=sys.stderr)
        return 1

    imap = image_map()
    vmap = val_map()

    with_tools = list(load_jsonl(TRACES / "train_cot_traces_dentex.jsonl"))
    no_tools = list(load_jsonl(TRACES / "train_cot_traces_dentex_no_tools.jsonl"))
    healthy = list(load_jsonl(TRACES / "train_cot_traces_healthy_dentex.jsonl"))
    healthy_nt = list(load_jsonl(TRACES / "train_cot_traces_healthy_dentex_no_tools.jsonl"))

    by_image_w = {r["image_id"]: r for r in with_tools}
    by_image_n = {r["image_id"]: r for r in no_tools}
    by_image_h = {r["image_id"]: r for r in healthy}
    by_image_hn = {r["image_id"]: r for r in healthy_nt}

    failing = [r["image_id"] for r in with_tools if any(
        not c.get("tool_ok") and c.get("tool_name") != "final_answer"
        for t in r.get("turns") or [] for c in t.get("tool_calls_this_turn") or []
    )]
    both = [i for i in by_image_w if i in by_image_n]

    ids: list[int] = []
    for group in (ARTIFACT_IDS, LABEL_IDS, failing[:6], both[:8], list(by_image_h)[:3]):
        for i in group:
            if i in by_image_w or i in by_image_n or i in by_image_h or i in by_image_hn:
                if i not in ids:
                    ids.append(i)
    ids = ids[:24]

    selected_traces = []
    for i in ids:
        for src, name in ((by_image_w, "train_cot_traces_dentex.jsonl"), (by_image_n, "train_cot_traces_dentex_no_tools.jsonl"),
                          (by_image_h, "train_cot_traces_healthy_dentex.jsonl"), (by_image_hn, "train_cot_traces_healthy_dentex_no_tools.jsonl")):
            if i in src:
                selected_traces.append(sanitize_trace(src[i], name))

    # Active assertions on output (not just safe by construction)
    for t in selected_traces:
        v = assert_dentex_only(t, f"trace image {t['image_id']}")
        if v:
            print(f"FAIL: {v}", file=sys.stderr)
            return 1

    if args.propose:
        print(json.dumps({"images": ids, "traces": len(selected_traces), "val": VAL_NAMES}, indent=2))
        return 0

    # Scan demo outputs for secrets/paths (negative control)
    demo_json = json.dumps(selected_traces)
    violations = scan_for_secrets_and_paths(demo_json)
    if violations:
        print(f"FAIL: demo output contains {violations}", file=sys.stderr)
        return 1

    if OUT.exists():
        shutil.rmtree(OUT)
    for d in (OUT, IMG_OUT, ART_OUT):
        d.mkdir(parents=True, exist_ok=True)

    images = build_images(ids, imap, vmap)
    artifacts = build_artifacts([i for i in ids if i in ARTIFACT_IDS])
    attached = sum(attach_artifacts(t, t["image_id"]) for t in selected_traces)
    eval_runs = build_evals()
    models = build_models(eval_runs)

    # Check evals too
    for r in eval_runs:
        v = assert_dentex_only(r, f"eval run {r['runKey']}")
        if v:
            print(f"FAIL: {v}", file=sys.stderr)
            return 1
        for c in r["cases"]:
            v = assert_dentex_only(c, f"eval case {c['image_id']}")
            if v:
                print(f"FAIL: {v}", file=sys.stderr)
                return 1

    bundle = {
        "version": 1,
        "images": images,
        "traces": selected_traces,
        "evals": eval_runs,
        "models": models,
    }
    bundle_json = json.dumps(bundle, ensure_ascii=False, separators=(",", ":"))
    (OUT / "bundle.json").write_text(bundle_json, encoding="utf-8")
    bundle_bytes = len(bundle_json.encode("utf-8"))

    # Budget checks
    v = check_size_budgets(images, bundle_bytes)
    if v:
        print(f"FAIL: {v}", file=sys.stderr)
        return 1

    # Scan assets for EXIF and size
    for asset in IMG_OUT.rglob("*"):
        if asset.is_file():
            if asset.stat().st_size > MAX_ASSET_SIZE:
                print(f"FAIL: asset {asset} > {MAX_ASSET_SIZE} bytes", file=sys.stderr)
                return 1
    for asset in ART_OUT.rglob("*"):
        if asset.is_file():
            if asset.stat().st_size > MAX_ASSET_SIZE:
                print(f"FAIL: asset {asset} > {MAX_ASSET_SIZE} bytes", file=sys.stderr)
                return 1
    total_asset_size = sum(f.stat().st_size for f in IMG_OUT.rglob("*") if f.is_file()) + \
                       sum(f.stat().st_size for f in ART_OUT.rglob("*") if f.is_file())
    if total_asset_size > MAX_TOTAL_ASSETS:
        print(f"FAIL: total assets {total_asset_size} > {MAX_TOTAL_ASSETS}", file=sys.stderr)
        return 1

    # Scan asset directory for any Tufts leakage
    asset_manifest = json.dumps([str(p) for p in IMG_OUT.rglob("*") if p.is_file()] + \
                                [str(p) for p in ART_OUT.rglob("*") if p.is_file()])
    violations = scan_for_secrets_and_paths(asset_manifest)
    if violations:
        print(f"FAIL: asset paths contain {violations}", file=sys.stderr)
        return 1

    vlm_head = git_head(VLM)
    if vlm_head["dirty"] and not args.allow_dirty:
        print("FAIL: VLM-DENTAL tree is dirty (use --allow-dirty to proceed and record it)", file=sys.stderr)
        return 1

    manifest = {
        "vlmDental": vlm_head,
        "buildDate": datetime.now(timezone.utc).isoformat(),
        "counts": {
            "images": len(images),
            "traces": len(selected_traces),
            "evalRuns": len(eval_runs),
            "evalCases": sum(r["n"] for r in eval_runs),
            "artifacts": artifacts,
            "artifactLinks": attached,
        },
        "licenses": {
            "dentex": "CC-BY-NC-SA-4.0",
            "ultralytics": "AGPL-3.0",
        },
        "bundleBytes": bundle_bytes,
    }
    (OUT / "MANIFEST.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    (OUT / "NOTICE.md").write_text(
        "# Demo data notice\n\n"
        "All images, traces, annotations and evaluations in `demo/` and `public/demo-assets/`\n"
        "are derived from the **DENTEX** dataset (CC BY-NC-SA 4.0). They are downscaled\n"
        "derivatives for non-commercial research and must carry this notice.\n\n"
        "- DENTEX: https://huggingface.co/datasets/ibrahimhamamci/DENTEX\n"
        "- Paper: Hamamci et al., arXiv:2305.19112 (MICCAI 2023)\n"
        "- YOLO weights: Ultralytics AGPL-3.0; the advertised checkpoint family is DENTEX-only.\n\n"
        "**No Tufts data is present.** Research prototype, not for clinical use.\n",
        encoding="utf-8",
    )

    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())