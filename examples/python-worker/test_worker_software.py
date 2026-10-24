"""Worker registration provenance (ADR-0024): the `software` block and re-register trigger.

These tests use a fake probe, so they run on a machine with no VLM-DENTAL checkout.
"""
from __future__ import annotations

import sys
import types
from typing import Any

import pytest

import worker


def fake_report(**overrides: Any) -> dict[str, Any]:
    report: dict[str, Any] = {
        "path": "C:/work/vlm-dental",
        "importable": True,
        "importError": None,
        "provenance": {"commit": "abc123", "branch": "main", "dirty": False},
        "python": "3.12.3",
        "packages": {"torch": "2.5.1+cu121", "transformers": "5.14.1", "peft": None},
        "packageErrors": {"transformers": "ImportError: hub too new"},
        "cuda": True,
        "tools": ["zoom_crop", "locate_tooth"],
        "toolsError": None,
        "jobs": {
            "tool.execute": {"available": True, "reason": None, "warnings": []},
            "agent.run.torch_hf": {
                "available": False,
                "reason": "python package 'transformers' cannot be imported",
                "warnings": ["optional python package 'peft' is not installed"],
            },
        },
        "available": ["tool.execute"],
        "unavailable": ["agent.run.torch_hf"],
        "advertisedJobs": ["tool.execute"],
        "unknownToApp": ["mystery_tool"],
        "missingUpstream": ["fdi_label"],
        "groundingWeights": "C:/work/vlm-dental/data/models/yolo_cv_best/weights/best.pt",
    }
    report.update(overrides)
    return report


@pytest.fixture()
def probed(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    report = fake_report()
    monkeypatch.setitem(sys.modules, "vlm_compat", types.SimpleNamespace(probe=lambda: report))
    return report


def test_software_carries_provenance_and_the_drift_report(probed: dict[str, Any]):
    sw = worker.compat_software()
    assert sw["python"] == "3.12.3"
    assert sw["torch"] == "2.5.1+cu121"
    assert sw["cuda"] == "available"
    assert sw["vlmDentalCommit"] == "abc123"
    assert sw["vlmDentalBranch"] == "main"
    assert sw["vlmDentalDirty"] is False
    assert sw["vlmDentalPath"] == "C:/work/vlm-dental"
    assert sw["packageErrors"] == {"transformers": "ImportError: hub too new"}
    assert sw["jobs"]["agent.run.torch_hf"]["available"] is False
    assert sw["jobs"]["agent.run.torch_hf"]["warnings"] == ["optional python package 'peft' is not installed"]
    assert sw["tools"] == ["zoom_crop", "locate_tooth"]
    assert sw["unknownToApp"] == ["mystery_tool"]
    assert sw["missingUpstream"] == ["fdi_label"]
    assert sw["advertisedJobs"] == ["tool.execute"]
    # `None` is not a valid optional string in the contract, so absent values are omitted.
    assert "compatError" not in sw
    assert "peft" in sw["packages"]  # the report keeps nulls; the contract type allows null here


def test_software_survives_a_missing_checkout(monkeypatch: pytest.MonkeyPatch):
    report = fake_report(
        path=None,
        importable=False,
        provenance={"commit": None, "branch": None, "dirty": None},
        packages={},
        packageErrors={},
        tools=[],
        advertisedJobs=[],
        unknownToApp=[],
        missingUpstream=["zoom_crop"],
        groundingWeights=None,
    )
    monkeypatch.setitem(sys.modules, "vlm_compat", types.SimpleNamespace(probe=lambda: report))
    sw = worker.compat_software()
    assert sw["python"]
    assert "vlmDentalCommit" not in sw  # nothing to claim
    assert "vlmDentalPath" not in sw
    assert "groundingWeights" not in sw
    assert sw["advertisedJobs"] == []


def test_software_survives_a_probe_that_raises(monkeypatch: pytest.MonkeyPatch):
    def boom() -> dict[str, Any]:
        raise RuntimeError("checkout is on fire")

    monkeypatch.setitem(sys.modules, "vlm_compat", types.SimpleNamespace(probe=boom))
    sw = worker.compat_software()
    assert sw["python"]
    assert sw["compatError"] == "RuntimeError: checkout is on fire"


def test_signature_is_stable_for_the_same_report_and_changes_with_it(monkeypatch: pytest.MonkeyPatch):
    report = fake_report()
    monkeypatch.setitem(sys.modules, "vlm_compat", types.SimpleNamespace(probe=lambda: report))
    _, first = worker.software_and_signature()
    _, second = worker.software_and_signature()
    assert first == second

    report["provenance"] = {"commit": "def456", "branch": "main", "dirty": True}
    _, third = worker.software_and_signature()
    assert third != first


def test_register_sends_the_software_block_and_the_advertised_jobs():
    sent: list[tuple[str, dict[str, Any]]] = []

    client = worker.Client("http://app", "tf_wrk_test")
    monkeypatch_post = lambda path, body: sent.append((path, body)) or {"workerId": "w-1"}  # noqa: E731
    client.post = monkeypatch_post  # type: ignore[method-assign]

    client.register("w", "local-gpu", ["system.ping"], software={"python": "3.12.3", "vlmDentalCommit": "abc123"})

    path, body = sent[0]
    assert path == "/register"
    assert body["software"] == {"python": "3.12.3", "vlmDentalCommit": "abc123"}
    assert body["capabilities"] == [{"job": "system.ping", "versions": [1]}]
    assert client.worker_id == "w-1"


def test_register_without_software_still_sends_python():
    sent: list[dict[str, Any]] = []
    client = worker.Client("http://app", "tf_wrk_test")
    client.post = lambda path, body: sent.append(body) or {"workerId": "w-1"}  # type: ignore[method-assign]

    client.register("w", "local-gpu", [])

    assert sent[0]["software"] == {"python": sys.version.split()[0]}
