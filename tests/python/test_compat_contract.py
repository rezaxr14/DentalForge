"""Compatibility contract against a real VLM-DENTAL checkout (ADR-0024).

Runs in two places:

* locally, against whatever checkout the owner has (`VLM_DENTAL_PATH`, default `../vlm-dental`);
* weekly in `.github/workflows/upstream-compat.yml`, against a throwaway clone of upstream `main`.

It skips with a visible reason when no checkout exists, **unless** `CI_REQUIRE_VLM=1`, which turns
the absence into a failure (the scheduled job must never pass by skipping).

A failure here is a DRIFT REPORT: upstream changed shape, or a numeric library changed a tool output.
It is never a reason to edit VLM-DENTAL, and goldens are regenerated only by the owner's decision.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

import pytest

import tools_goldens
import vlm_compat

ROOT = Path(__file__).resolve().parents[2]
GOLDEN_PATH = ROOT / "fixtures" / "goldens" / "vlm_tools.json"
REQUIRE_CHECKOUT = os.environ.get("CI_REQUIRE_VLM") == "1"

CHECKOUT = vlm_compat.default_path()
if CHECKOUT is None:
    _MISSING = (
        "VLM-DENTAL checkout not found (set VLM_DENTAL_PATH, or clone it next to this repo). "
        "CI_REQUIRE_VLM=1 makes this a failure instead of a skip."
    )
    if REQUIRE_CHECKOUT:
        pytest.fail(_MISSING, pytrace=False)
    pytest.skip(_MISSING, allow_module_level=True)

# Table 4.3 of VLM_INTEGRATION_IMPLEMENTATION_PLAN.md: capability profile -> torch requirement.
# `agent.run` has two interchangeable backends, so the probe reports one row per backend.
TABLE_4_3 = {
    "tool.execute": False,
    "trace.render_artifacts": False,
    "yolo.prelabel": True,
    "al.score": True,
    "agent.run.openai_compat": False,
    "agent.run.torch_hf": True,
    "eval.run": True,
}

REASON_FORMS = re.compile(
    r"python package '.*?' (is not installed|cannot be imported)"
    r"|dental_agent not importable"
    r"|not found"
    r"|parameter\(s\)"
    r"|not in ToolRegistry"
    r"|grounding weights file not found"
    r"|CUDA is not available"
    r"|ToolRegistry unavailable"
)


@pytest.fixture(scope="module")
def report() -> dict:
    return vlm_compat.probe(CHECKOUT)


def _git_status() -> str:
    r = subprocess.run(
        ["git", "-C", str(CHECKOUT), "status", "--porcelain"],
        capture_output=True,
        text=True,
        check=False,
    )
    return r.stdout


def test_probe_covers_every_row_of_table_4_3(report: dict):
    assert set(report["jobs"]) == set(TABLE_4_3)
    for job, needs_torch in TABLE_4_3.items():
        row = report["jobs"][job]
        assert row["needsTorch"] is needs_torch, job
        if row["available"]:
            assert row["reason"] is None, f"{job} is available but carries a reason"
        else:
            assert row["reason"], f"{job} is unavailable without a reason"


def test_every_unavailable_reason_is_a_known_precise_form(report: dict):
    for job, row in report["jobs"].items():
        if row["available"]:
            continue
        assert REASON_FORMS.search(row["reason"]), f"{job}: unclear reason {row['reason']!r}"


def test_openai_compat_backend_never_needs_torch(report: dict):
    assert report["jobs"]["agent.run.openai_compat"]["needsTorch"] is False


def test_the_apps_tool_contract_is_visible(report: dict):
    if report.get("toolsError"):
        # A torch-free install cannot build the registry (`create_default()` imports ultralytics).
        # That is "not installed here", not drift; the weekly light job still checks the signatures.
        if "ImportError" in report["toolsError"] or "ModuleNotFoundError" in report["toolsError"]:
            pytest.skip(f"tool runtime not installed here: {report['toolsError']}")
        pytest.fail(f"ToolRegistry could not be read: {report['toolsError']}", pytrace=False)
    if report["missingUpstream"]:
        pytest.fail(
            "upstream no longer registers tool(s) the app's contract knows: "
            + ", ".join(report["missingUpstream"]),
            pytrace=False,
        )
    # Extra upstream tools are executed through the generic path; they are reported, never fatal.
    assert all(isinstance(t, str) for t in report["unknownToApp"])


def test_probe_does_not_modify_the_checkout(report: dict):
    before = _git_status()
    vlm_compat.probe(CHECKOUT)
    assert _git_status() == before


ALL_TOOLS = tuple(name for name, _ in tools_goldens.tool_cases(1, 1))


@pytest.fixture(scope="module")
def tool_run(report: dict) -> dict:
    try:
        current = tools_goldens.collect(CHECKOUT)
    except Exception as e:  # noqa: BLE001 - missing runtime is a skip, not a crash
        message = f"could not run the tool contract: {type(e).__name__}: {e}"
        if REQUIRE_CHECKOUT:
            pytest.fail(message, pytrace=False)
        pytest.skip(message)
    # The only tool a torch-free install may skip is grounding; anything else would hide drift.
    assert set(current.get("skipped") or []) <= {"locate_tooth"}
    return current


@pytest.fixture(scope="module")
def golden() -> dict:
    if not GOLDEN_PATH.is_file():
        pytest.fail(f"tool golden missing: {GOLDEN_PATH} (owner runs tools_goldens.py --write)", pytrace=False)
    return json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))


def _only(run: dict, tools: tuple[str, ...]) -> dict:
    return {
        "images": run.get("images") or {},
        "tools": {
            image: {t: v for t, v in entries.items() if t in tools}
            for image, entries in (run.get("tools") or {}).items()
        },
        "skipped": run.get("skipped") or [],
    }


def test_deterministic_tool_goldens_match(tool_run: dict, golden: dict):
    tools = tuple(t for t in ALL_TOOLS if t not in tools_goldens.MODEL_TOOLS)
    drift = tools_goldens.diff(_only(golden, tools), _only(tool_run, tools))
    assert not drift, "DRIFT (a report, not an automatic bug):\n" + "\n".join(drift)


def test_model_tool_goldens_match_in_the_recorded_environment(tool_run: dict, golden: dict):
    recorded = golden.get("environment") or {}
    current = tool_run.get("environment") or {}
    if recorded != current:
        changed = [
            f"{name}: {recorded.get('packages', {}).get(name)} -> {current.get('packages', {}).get(name)}"
            for name in sorted(set(recorded.get("packages") or {}) | set(current.get("packages") or {}))
            if (recorded.get("packages") or {}).get(name) != (current.get("packages") or {}).get(name)
        ]
        pytest.skip(
            "model tool numbers are only comparable on the golden's stack; changed: "
            + ("; ".join(changed) or "python version")
        )
    drift = tools_goldens.diff(
        _only(golden, tools_goldens.MODEL_TOOLS), _only(tool_run, tools_goldens.MODEL_TOOLS)
    )
    assert not drift, "DRIFT (a report, not an automatic bug):\n" + "\n".join(drift)
