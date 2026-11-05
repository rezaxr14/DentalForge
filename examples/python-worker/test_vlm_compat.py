"""Unit tests for the VLM-DENTAL compatibility probe (ADR-0024).

These tests never touch the owner's checkout: each builds a tiny fake `dental_agent` package in a
temporary directory, so a passing run proves the probe reacts to the SHAPE of the package rather than
to this machine's install. `test_compat_contract.py` is the separate test that runs against the real
checkout when one is present.
"""
from __future__ import annotations

import sys
import textwrap
from pathlib import Path

import pytest

import vlm_compat


@pytest.fixture(autouse=True)
def _isolate_dental_agent_modules():
    """A fake package imported by one test must not leak into the next one."""
    before = {k: v for k, v in sys.modules.items() if k == "dental_agent" or k.startswith("dental_agent.")}
    for k in before:
        sys.modules.pop(k, None)
    yield
    for k in [k for k in sys.modules if k == "dental_agent" or k.startswith("dental_agent.")]:
        sys.modules.pop(k, None)
    sys.modules.update(before)


def _write(root: Path, rel: str, source: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(source), encoding="utf-8")


def make_package(
    root: Path,
    *,
    tools: tuple[str, ...] = ("zoom_crop", "fdi_label"),
    prompts: bool = False,
    parse_param: str = "text",
    dispatch: bool = True,
    registry_error: str | None = None,
) -> Path:
    """A fake checkout with exactly the modules a job type needs (and nothing else)."""
    pkg = root / "checkout"
    _write(pkg, "dental_agent/__init__.py", "")
    _write(pkg, "dental_agent/tools/__init__.py", "")
    if registry_error is not None:
        _write(
            pkg,
            "dental_agent/tools/registry.py",
            f"""
            raise ImportError({registry_error!r})
            """,
        )
    else:
        _write(
            pkg,
            "dental_agent/tools/registry.py",
            f"""
            from types import SimpleNamespace

            class ToolRegistry:
                @classmethod
                def create_default(cls):
                    return cls()

                def list_tools(self):
                    return [SimpleNamespace(name=n) for n in {tools!r}]
            """,
        )
    if dispatch:
        _write(
            pkg,
            "dental_agent/agent/__init__.py",
            "",
        )
        _write(
            pkg,
            "dental_agent/agent/tool_dispatch.py",
            """
            def execute_tool_call(registry, tool_name, tool_args, image):
                return {"ok": True}
            """,
        )
    _write(pkg, "dental_agent/utils/__init__.py", "")
    _write(
        pkg,
        "dental_agent/utils/canonical.py",
        """
        def to_canonical(image, family):
            return image

        def family_for_tool(name):
            return "FULL"
        """,
    )
    if prompts:
        _write(
            pkg,
            "dental_agent/agent/prompts.py",
            """
            FIRST_USER_PROMPT = "Analyze this panoramic X-ray."
            NO_TOOLS_SYSTEM_PROMPT = "No tools."

            def build_agent_system_prompt(tools_description, dataset="dentex"):
                return tools_description
            """,
        )
        _write(
            pkg,
            "dental_agent/agent/parsing.py",
            f"""
            def parse_agent_json({parse_param}):
                return None
            """,
        )
    return pkg


def test_no_checkout_reports_every_job_unavailable_without_raising(tmp_path: Path):
    report = vlm_compat.probe(tmp_path / "does-not-exist")
    assert report["path"] is None
    assert report["importable"] is False
    assert report["available"] == []
    assert set(report["unavailable"]) == set(vlm_compat.JOB_DEPENDENCIES)


def test_tool_jobs_are_advertised_and_unknown_tools_are_flagged_but_not_fatal(tmp_path: Path):
    pkg = make_package(tmp_path, tools=("zoom_crop", "fdi_label", "mystery_tool"))
    report = vlm_compat.probe(pkg)
    assert report["importable"] is True
    assert report["jobs"]["tool.execute"]["available"] is True
    assert report["jobs"]["trace.render_artifacts"]["available"] is True
    # Unknown to the app: executed through the generic path, and reported.
    assert report["unknownToApp"] == ["mystery_tool"]
    assert "zoom_crop" not in report["missingUpstream"]


def test_missing_agent_symbols_mark_only_the_agent_jobs_unavailable(tmp_path: Path):
    pkg = make_package(tmp_path, prompts=False)
    report = vlm_compat.probe(pkg)
    assert report["jobs"]["tool.execute"]["available"] is True
    assert report["jobs"]["agent.run.openai_compat"]["available"] is False
    assert "dental_agent.agent.prompts" in report["jobs"]["agent.run.openai_compat"]["reason"]
    # torch is absent in the light CI environment; even with the package present, torch_hf must be off.
    assert report["jobs"]["agent.run.torch_hf"]["available"] is False


def test_a_renamed_required_parameter_is_a_precise_reason_not_a_crash(tmp_path: Path):
    pkg = make_package(tmp_path, prompts=True, parse_param="payload")
    report = vlm_compat.probe(pkg)
    reason = report["jobs"]["agent.run.openai_compat"]["reason"]
    assert report["jobs"]["agent.run.openai_compat"]["available"] is False
    assert "parse_agent_json" in reason
    assert "'text'" in reason
    # A different job type stays available: one drifted symbol must not disable everything.
    assert report["jobs"]["tool.execute"]["available"] is True


def test_openai_compat_is_available_when_all_its_symbols_match(tmp_path: Path):
    pkg = make_package(tmp_path, prompts=True)
    report = vlm_compat.probe(pkg)
    assert report["jobs"]["agent.run.openai_compat"]["available"] is True
    assert report["jobs"]["agent.run.openai_compat"]["reason"] is None


def test_missing_tools_expected_by_the_app_are_reported_as_missing_upstream(tmp_path: Path):
    pkg = make_package(tmp_path, tools=("zoom_crop",))
    report = vlm_compat.probe(pkg)
    assert "fdi_label" in report["missingUpstream"]
    assert report["jobs"]["tool.execute"]["available"] is True  # the registry itself still works


def test_unbuildable_registry_disables_jobs_instead_of_advertising_them(tmp_path: Path):
    """`create_default()` imports ultralytics, so a torch-free install cannot build a registry."""
    pkg = make_package(tmp_path, prompts=True, registry_error="No module named 'ultralytics'")
    report = vlm_compat.probe(pkg)
    row = report["jobs"]["tool.execute"]
    assert row["available"] is False
    assert "ultralytics" in row["reason"]
    # Either the symbol check or the registry check catches it first; both name the real cause.
    assert "ToolRegistry" in row["reason"] or "dental_agent.tools.registry" in row["reason"]
    assert report["advertisedJobs"] == []


def test_signature_check_tolerates_kwargs_and_defaults(tmp_path: Path):
    pkg = make_package(tmp_path, prompts=True, parse_param="**kwargs")
    report = vlm_compat.probe(pkg)
    assert report["jobs"]["agent.run.openai_compat"]["available"] is True


def test_provenance_is_reported_but_never_used_for_availability(tmp_path: Path):
    pkg = make_package(tmp_path, prompts=True)
    report = vlm_compat.probe(pkg)
    assert set(report["provenance"]) == {"commit", "branch", "dirty"}
    assert report["provenance"]["commit"] is None  # not a git repo
    assert report["jobs"]["tool.execute"]["available"] is True


def test_explicit_env_path_is_authoritative(tmp_path: Path):
    """An owner who names a checkout must not silently get a different one probed."""
    assert vlm_compat.default_path({"VLM_DENTAL_PATH": str(tmp_path / "missing")}) is None
    pkg = make_package(tmp_path)
    assert vlm_compat.default_path({"VLM_DENTAL_PATH": str(pkg)}) == pkg.resolve()


def test_probe_isolated_returns_the_same_report_shape_from_a_child_process(tmp_path: Path):
    pkg = make_package(tmp_path, prompts=True)
    report = vlm_compat.probe_isolated(pkg)
    assert report["path"] == str(pkg.resolve())
    assert report["jobs"]["tool.execute"]["available"] is True
    assert report["advertisedJobs"] == ["tool.execute", "trace.render_artifacts", "agent.run"]


def test_a_probe_that_kills_its_process_becomes_a_report_not_a_crash(tmp_path: Path):
    """A broken native dependency can abort the interpreter; the worker must still register."""
    pkg = make_package(tmp_path)
    _write(pkg, "dental_agent/__init__.py", "import os\nos._exit(1)\n")

    report = vlm_compat.probe_isolated(pkg)

    assert report["path"] is None
    assert "probe subprocess failed" in report["importError"]
    assert report["advertisedJobs"] == []
    assert set(report["unavailable"]) == set(vlm_compat.JOB_DEPENDENCIES)


def test_summary_is_human_readable_and_names_each_unavailable_job(tmp_path: Path):
    pkg = make_package(tmp_path, prompts=False)
    text = vlm_compat.summary(vlm_compat.probe(pkg))
    assert "jobs:" in text
    assert "SKIP agent.run.openai_compat" in text
    assert "OK   tool.execute" in text
    assert "provenance only" in text


def test_probe_leaves_no_bytecode_in_the_checkout(tmp_path: Path):
    """The VLM-DENTAL tree is a read-only input: probing it must not create `__pycache__`."""
    pkg = make_package(tmp_path, prompts=True)
    vlm_compat.probe(pkg)
    assert list(pkg.rglob("__pycache__")) == []


def test_import_problem_is_none_for_a_healthy_module():
    assert vlm_compat._import_problem("json") is None


def test_installed_but_broken_package_disables_only_the_jobs_that_need_it(tmp_path: Path, monkeypatch):
    """The exact failure this repo's owner hit: `find_spec` finds transformers, importing it raises."""
    pkg = make_package(tmp_path, prompts=True)
    broken_root = tmp_path / "broken-root"
    _write(broken_root, "vlm_broken_pkg/__init__.py", 'raise ImportError("hub version check failed")')
    monkeypatch.syspath_prepend(str(broken_root))
    monkeypatch.setitem(
        vlm_compat.JOB_DEPENDENCIES,
        "agent.run.openai_compat",
        vlm_compat.JobDependency(
            symbols=vlm_compat._OPENAI_SYMBOLS, packages=("vlm_broken_pkg",)
        ),
    )

    report = vlm_compat.probe(pkg)

    reason = report["jobs"]["agent.run.openai_compat"]["reason"]
    assert report["jobs"]["agent.run.openai_compat"]["available"] is False
    assert "cannot be imported" in reason
    assert "hub version check failed" in reason
    assert report["packageErrors"]["vlm_broken_pkg"].startswith("ImportError")
    # Jobs that do not need the broken package are unaffected.
    assert report["jobs"]["tool.execute"]["available"] is True


def test_packages_are_not_imported_for_a_job_that_is_already_unavailable(tmp_path: Path, monkeypatch):
    """A drifted symbol must not make the probe pay the torch import cost."""
    pkg = make_package(tmp_path, prompts=False)
    calls: list[str] = []

    def fake_import_problem(name: str) -> str | None:
        calls.append(name)
        return None

    monkeypatch.setattr(vlm_compat, "_import_problem", fake_import_problem)
    vlm_compat.probe(pkg)
    assert "torch" not in calls
    assert "transformers" not in calls
