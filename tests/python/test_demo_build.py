"""Public-safety guards for the demo bundle builder (`scripts/demo_build.py`).

Every test here is a guard, not a snapshot: the builder is what decides whether
DENTEX-only data, secrets or personal paths can reach a public artifact.
"""
from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

import pytest
from PIL import Image

REPO = Path(__file__).resolve().parents[2]
MODULE_PATH = REPO / "scripts" / "demo_build.py"


def _load():
    spec = importlib.util.spec_from_file_location("demo_build", MODULE_PATH)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


demo_build = _load()


# ── canary: secrets and personal paths ───────────────────────────────────────

@pytest.mark.parametrize(
    "text, expected",
    [
        ("token hf_abcdefghijklmnopqrstuvwxyz123456", "secret:Hugging Face token"),
        ("key sk-abcdefghijklmnopqrstuvwxyz123456", "secret:OpenAI-style secret"),
        ("key AIza" + "a" * 35, "secret:Google API key"),
        (r"see C:\Users\owner\secret\model.bin", "windows_path"),
        ("home /home/owner/project/file", "unix_home_path"),
        ("dataset Tufts-2024", "tufts_reference"),
    ],
)
def test_scan_flags_each_forbidden_pattern(text, expected):
    assert expected in demo_build.scan_for_secrets_and_paths(text)


def test_scan_allows_clean_demo_text():
    clean = json.dumps({"dataset": "dentex", "path": "demo-assets/images/dentex-1.jpg"})
    assert demo_build.scan_for_secrets_and_paths(clean) == []


# ── licence guard: DENTEX only, asserted on the item itself ─────────────────

def test_assert_dentex_only_accepts_dentex():
    assert demo_build.assert_dentex_only({"dataset": "dentex", "sourceFile": "train.jsonl"}, "ok") == []


@pytest.mark.parametrize(
    "item, fragment",
    [
        ({"dataset": "tufts", "sourceFile": "x.jsonl"}, "dataset is tufts"),
        ({"dataset": "other", "sourceFile": "x.jsonl"}, "dataset is other, not dentex"),
        ({"dataset": "dentex", "sourceFile": "tufts/train.jsonl"}, "tufts in sourceFile"),
    ],
)
def test_assert_dentex_only_rejects_non_dentex(item, fragment):
    violations = demo_build.assert_dentex_only(item, "ctx")
    assert any(fragment in v for v in violations)


# ── sanitiser: allow-list only, bounded text, dataset forced ────────────────

def test_sanitize_trace_drops_unknown_fields_and_bounds_text():
    raw = {
        "image_id": 7,
        "dataset": "tufts",  # must be forced to dentex
        "ground_truth": [{"quadrant": 1}],
        "tool_calls": 3,
        "format_ok": 1,
        "source_file": "train.jsonl",
        "secret_note": "hf_abcdefghijklmnopqrstuvwxyz123456",
        "turns": [
            {
                "turn": 1,
                "status": "ok",
                "raw_output": "x" * 5000,
                "private_extra": "drop me",
                "parsed": {"thought": "y" * 5000, "final_answer": {"ok": True}, "hidden": "drop me"},
                "tool_calls_this_turn": [
                    {"tool_name": "detect", "tool_args": {"n": 1}, "tool_ok": True, "secret": "drop me"},
                ],
            }
        ],
    }
    out = demo_build.sanitize_trace(raw, "train.jsonl")

    assert out["dataset"] == "dentex"
    assert out["source_file"] == "train.jsonl"
    assert "secret_note" not in out
    turn = out["turns"][0]
    assert "private_extra" not in turn
    assert len(turn["raw_output"]) == 2000
    assert set(turn["parsed"]) == {"thought", "final_answer"}
    assert len(turn["parsed"]["thought"]) == 2000
    call = turn["tool_calls_this_turn"][0]
    assert "secret" not in call
    assert set(call) == {"tool_name", "tool_args", "tool_ok"}


def test_sanitize_trace_keeps_only_allow_listed_top_level_fields():
    out = demo_build.sanitize_trace({"image_id": 1, "dataset": "dentex", "turns": [], "junk": 1}, "t.jsonl")
    assert set(out) <= demo_build.ALLOWED_TRACE_FIELDS
    assert "junk" not in out


# ── budgets ─────────────────────────────────────────────────────────────────

def test_check_size_budgets_accepts_small_bundle():
    assert demo_build.check_size_budgets(1_000, [100, 200]) == []


def test_check_size_budgets_rejects_bundle_asset_and_total():
    assert any("bundle.json" in v for v in demo_build.check_size_budgets(demo_build.MAX_BUNDLE_SIZE + 1, []))
    assert any("asset" in v for v in demo_build.check_size_budgets(1, [demo_build.MAX_ASSET_SIZE + 1]))
    assert any("total assets" in v for v in demo_build.check_size_budgets(1, [demo_build.MAX_TOTAL_ASSETS + 1]))


# ── the committed artifacts themselves ─────────────────────────────────────

def test_committed_manifest_lists_every_asset_with_sha256():
    manifest = json.loads((REPO / "demo" / "MANIFEST.json").read_text(encoding="utf-8"))
    assert manifest["vlmDental"]["commit"]
    assert manifest["vlmDental"]["branch"]
    assert isinstance(manifest["vlmDental"]["dirty"], bool)
    assert manifest["buildDate"]
    assert manifest["toolVersions"]["python"]
    assert manifest["toolVersions"]["pillow"]
    assets = manifest["assets"]
    assert len(assets) >= 80
    on_disk = sorted(p for p in (REPO / "public" / "demo-assets").rglob("*") if p.is_file())
    assert len(assets) == len(on_disk)
    for row in assets:
        assert row["path"].startswith("demo-assets/")
        assert re.fullmatch(r"[0-9a-f]{64}", row["sha256"])
        path = REPO / "public" / row["path"]
        assert path.is_file()
        assert row["bytes"] == path.stat().st_size
        assert row["sha256"] == demo_build.sha256_file(path)


def test_committed_bundle_and_asset_paths_are_clean():
    bundle_text = (REPO / "demo" / "bundle.json").read_text(encoding="utf-8")
    assert demo_build.scan_for_secrets_and_paths(bundle_text) == []
    manifest = json.loads((REPO / "demo" / "MANIFEST.json").read_text(encoding="utf-8"))
    paths = json.dumps([a["path"] for a in manifest["assets"]])
    assert demo_build.scan_for_secrets_and_paths(paths) == []


def test_committed_assets_have_no_exif():
    for path in sorted((REPO / "public" / "demo-assets").rglob("*")):
        if not path.is_file() or path.suffix.lower() not in {".jpg", ".jpeg"}:
            continue
        with Image.open(path) as im:
            assert not dict(im.getexif()), f"{path} carries EXIF"
