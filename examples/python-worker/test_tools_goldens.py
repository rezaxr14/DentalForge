"""Unit tests for the tool-golden helpers (ADR-0024). No checkout, no model: pure functions only."""
from __future__ import annotations

from PIL import Image

import tools_goldens as tg


def test_describe_hashes_raw_pixels_and_records_size():
    a = Image.new("RGB", (4, 3), (1, 2, 3))
    b = Image.new("RGB", (4, 3), (1, 2, 3))
    c = Image.new("RGB", (4, 3), (3, 2, 1))

    assert tg.describe(a) == tg.describe(b)
    assert tg.describe(a) != tg.describe(c)
    assert tg.describe(a)["size"] == [4, 3]
    assert tg.describe(a)["mode"] == "RGB"


def test_describe_rounds_floats_so_goldens_do_not_churn_on_last_bits():
    assert tg.describe({"bbox": [1.00000001, 2.5], "conf": 0.123456789}) == {
        "kind": "data",
        "data": {"bbox": [1.0, 2.5], "conf": 0.1235},
    }


def test_tool_cases_covers_all_eight_tools_and_stays_inside_the_image():
    cases = tg.tool_cases(1000, 800)
    assert [name for name, _ in cases] == [
        "zoom_crop",
        "window_level",
        "locate_tooth",
        "fdi_label",
        "denoise",
        "contralateral_compare",
        "enhance_contrast",
        "nudge_crop",
    ]
    for name, args in cases:
        box = args.get("bbox")
        if box:
            x, y, w, h = box
            assert x >= 0 and y >= 0 and x + w <= 1000 and y + h <= 800, name


def test_diff_names_the_image_and_tool_that_changed():
    golden = {
        "images": {"val_18.png": {"size": [10, 10], "fileSha256": "a"}},
        "tools": {"val_18.png": {"zoom_crop": {"kind": "image", "size": [5, 5]}}},
    }
    current = {
        "images": {"val_18.png": {"size": [10, 10], "fileSha256": "a"}},
        "tools": {"val_18.png": {"zoom_crop": {"kind": "image", "size": [6, 5]}}},
        "skipped": [],
    }
    lines = tg.diff(golden, current)
    assert len(lines) == 1
    assert "val_18.png/zoom_crop" in lines[0]
    assert "expected" in lines[0] and "got" in lines[0]


def test_diff_reports_a_changed_sample_image():
    golden = {"images": {"val_18.png": {"size": [10, 10], "fileSha256": "a"}}, "tools": {}}
    current = {"images": {"val_18.png": {"size": [10, 10], "fileSha256": "b"}}, "tools": {}, "skipped": []}
    assert tg.diff(golden, current) == ["val_18.png: sample image changed (size/fileSha256)"]


def test_diff_does_not_call_a_deliberately_skipped_tool_drift():
    golden = {"images": {}, "tools": {"val_18.png": {"locate_tooth": {"kind": "data", "data": {}}}}}
    current = {"images": {}, "tools": {"val_18.png": {}}, "skipped": ["locate_tooth"]}
    assert tg.diff(golden, current) == []


def test_diff_reports_a_tool_that_vanished_from_the_run():
    golden = {"images": {}, "tools": {"val_18.png": {"zoom_crop": {"kind": "image", "size": [1, 1]}}}}
    current = {"images": {}, "tools": {"val_18.png": {}}, "skipped": []}
    lines = tg.diff(golden, current)
    assert lines == ["val_18.png/zoom_crop: not produced by the current run"]
