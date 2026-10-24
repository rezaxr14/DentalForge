"""Compatibility probe for a VLM-DENTAL checkout (ADR-0024).

VLM-DENTAL is under continuous development, so the worker never pins a commit. Instead it
**feature-detects** what the checkout on this machine can actually do, advertises exactly those
job types, and reports why the others are unavailable. A changed checkout is a new report, not a
crash.

Design rules (VLM_INTEGRATION plan section 4):

* `probe(path)` is pure and fast: no model load, no GPU work, no network. It only imports modules
  and inspects signatures. Importing `dental_agent.agent.loop` pulls torch (through
  `model.inference`), which is why each job type lists its own dependency set instead of probing
  everything.
* A missing *required* parameter marks the job unavailable with a precise reason; extra parameters
  with defaults are tolerated, and ``**kwargs`` satisfies any parameter check.
* The git commit/branch/dirty flag is **provenance only** and never gates behaviour.
* Nothing here imports the app or writes to the VLM-DENTAL tree.

CLI (used by `pnpm compat`; `--path` is resolved against the current directory, so run it from the
repo root):

    python examples/python-worker/vlm_compat.py [--path ../vlm-dental] [--json]

Exit code is 0 when the probe ran (whatever it found), 2 when no checkout could be found.
"""
from __future__ import annotations

import dataclasses
import importlib
import importlib.util
import inspect
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable

# The checkout is a read-only input. Importing its modules would otherwise drop `__pycache__` into
# the owner's tree, so bytecode writing is disabled for this process before any import happens.
sys.dont_write_bytecode = True

# The 8 tools the app's contract knows about (src/shared/contracts/worker.ts ToolExecutePayload).
APP_TOOLS = (
    "zoom_crop",
    "window_level",
    "locate_tooth",
    "fdi_label",
    "denoise",
    "contralateral_compare",
    "enhance_contrast",
    "nudge_crop",
)


@dataclasses.dataclass(frozen=True)
class Symbol:
    module: str
    name: str
    # Parameter names that must exist (with or without a default) on the callable.
    required_params: tuple[str, ...] = ()


@dataclasses.dataclass(frozen=True)
class JobDependency:
    symbols: tuple[Symbol, ...]
    packages: tuple[str, ...] = ()
    needs_cuda: bool = False
    needs_grounding_weights: bool = False
    # Tools that must be present in `ToolRegistry.create_default()`, e.g. grounding is only usable if
    # `locate_tooth` is still registered.
    requires_tools: tuple[str, ...] = ()
    # The registry itself must be constructible. `create_default()` imports the grounding module,
    # which imports ultralytics, so a "torch-free" install cannot build it — advertise nothing rather
    # than route a job here.
    needs_registry: bool = False
    # Installed but not required: the job runs without them, with a warning (peft only matters for
    # adapter checkpoints, so a base-model run must not be disabled by a broken peft).
    optional_packages: tuple[str, ...] = ()


_TOOL_SYMBOLS = (
    Symbol("dental_agent.tools.registry", "ToolRegistry"),
    Symbol("dental_agent.agent.tool_dispatch", "execute_tool_call", ("registry", "tool_name", "tool_args", "image")),
    Symbol("dental_agent.utils.canonical", "to_canonical"),
    Symbol("dental_agent.utils.canonical", "family_for_tool"),
)

_OPENAI_SYMBOLS = _TOOL_SYMBOLS + (
    Symbol("dental_agent.agent.prompts", "build_agent_system_prompt", ("tools_description",)),
    Symbol("dental_agent.agent.prompts", "FIRST_USER_PROMPT"),
    Symbol("dental_agent.agent.prompts", "NO_TOOLS_SYSTEM_PROMPT"),
    Symbol("dental_agent.agent.parsing", "parse_agent_json", ("text",)),
)

_TORCH_AGENT_SYMBOLS = _OPENAI_SYMBOLS + (
    Symbol("dental_agent.model.backbone", "load_model"),
    Symbol("dental_agent.model.checkpoints", "load_checkpoint", ("checkpoint_dir", "tag")),
    Symbol("dental_agent.agent.loop", "run_agent", ("image_id", "images_df", "model", "processor")),
    Symbol("dental_agent.agent.loop", "run_agent_no_tools", ("image_id", "images_df", "model", "processor")),
)

JOB_DEPENDENCIES: dict[str, JobDependency] = {
    "tool.execute": JobDependency(symbols=_TOOL_SYMBOLS, needs_registry=True),
    "trace.render_artifacts": JobDependency(symbols=_TOOL_SYMBOLS, needs_registry=True),
    "yolo.prelabel": JobDependency(
        symbols=(Symbol("dental_agent.tools.grounding", "ToothGrounder"),),
        packages=("ultralytics", "torch"),
        needs_grounding_weights=True,
        requires_tools=("locate_tooth",),
        needs_registry=True,
    ),
    "al.score": JobDependency(
        symbols=(Symbol("dental_agent.tools.grounding", "ToothGrounder"),),
        packages=("ultralytics", "torch"),
        needs_grounding_weights=True,
        requires_tools=("locate_tooth",),
        needs_registry=True,
    ),
    "agent.run.openai_compat": JobDependency(symbols=_OPENAI_SYMBOLS, needs_registry=True),
    "agent.run.torch_hf": JobDependency(
        symbols=_TORCH_AGENT_SYMBOLS,
        packages=("torch", "transformers"),
        optional_packages=("peft",),
        needs_registry=True,
    ),
    "eval.run": JobDependency(
        symbols=_TORCH_AGENT_SYMBOLS
        + (Symbol("dental_agent.data.dentex", "load_dentex_dataset"),),
        packages=("torch", "transformers"),
        optional_packages=("peft",),
        needs_registry=True,
    ),
}

# Capability keys are finer than contract job types: `agent.run` has two interchangeable backends and
# is advertised once when either works. The app only ever sees the contract job name.
CAPABILITY_JOBS: dict[str, str] = {
    "tool.execute": "tool.execute",
    "trace.render_artifacts": "trace.render_artifacts",
    "yolo.prelabel": "yolo.prelabel",
    "al.score": "al.score",
    "agent.run.openai_compat": "agent.run",
    "agent.run.torch_hf": "agent.run",
    "eval.run": "eval.run",
}

OPTIONAL_PACKAGES = ("torch", "transformers", "peft", "ultralytics", "bitsandbytes")


def default_path(env: dict[str, str] | None = None) -> Path | None:
    """Resolve VLM_DENTAL_PATH, then the two folder spellings the owner uses.

    An explicitly set VLM_DENTAL_PATH is authoritative: if it does not contain `dental_agent` the
    answer is `None` (the caller reports a missing checkout) rather than silently probing a different
    tree than the one the owner named.
    """
    env = os.environ if env is None else env
    explicit = env.get("VLM_DENTAL_PATH")
    if explicit:
        chosen = Path(explicit).expanduser()
        return chosen.resolve() if (chosen / "dental_agent").is_dir() else None
    candidates: list[Path] = []
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidates.append(parent / "VLM-DENTAL")
        candidates.append(parent / "vlm-dental")
    candidates.append(Path.cwd() / "VLM-DENTAL")
    candidates.append(Path.cwd() / "vlm-dental")
    for c in candidates:
        if (c / "dental_agent").is_dir():
            return c.resolve()
    return None


def _git(path: Path, *args: str) -> str | None:
    try:
        r = subprocess.run(
            ["git", "-C", str(path), *args],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout.strip() if r.returncode == 0 else None


def provenance(path: Path) -> dict[str, Any]:
    """Commit/branch/dirty — provenance ONLY; never used to decide availability."""
    status = _git(path, "status", "--porcelain")
    return {
        "commit": _git(path, "rev-parse", "HEAD"),
        "branch": _git(path, "rev-parse", "--abbrev-ref", "HEAD"),
        "dirty": bool(status) if status is not None else None,
    }


def _package_version(name: str) -> str | None:
    """Version from installed metadata only — importing torch/peft just to read a version is slow and
    can crash the interpreter at shutdown, which would break a "fast probe"."""
    if importlib.util.find_spec(name) is None:
        return None
    try:
        from importlib.metadata import PackageNotFoundError, version

        return version(name)
    except PackageNotFoundError:
        return "present"
    except Exception:  # noqa: BLE001 - metadata is best-effort; presence is what gates jobs
        return "present"


def _cuda_visible() -> bool:
    """A CUDA device visible to the driver. Uses `nvidia-smi` so the probe never imports torch."""
    try:
        r = subprocess.run(
            ["nvidia-smi", "-L"], capture_output=True, text=True, timeout=5, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return r.returncode == 0 and "GPU" in r.stdout


def _present(name: str) -> bool:
    """`find_spec` without importing; a broken parent package counts as absent."""
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def _import_problem(name: str) -> str | None:
    """`None` when `name` imports cleanly, else the precise reason.

    Presence is not enough: `find_spec("transformers")` succeeds on an install whose own version
    check raises at import time (the state this repo's owner hit), and a job that needs it cannot run.
    """
    try:
        importlib.import_module(name)
    except Exception as e:  # noqa: BLE001 - the import error is exactly what the report needs
        first = str(e).strip().splitlines()
        return f"{type(e).__name__}: {first[0]}" if first else type(e).__name__
    return None


def _missing_required_params(fn: Any, required: Iterable[str]) -> list[str]:
    """Required parameter names absent from the callable's signature (``**kwargs`` satisfies all)."""
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return []
    params = sig.parameters
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return []
    names = {
        n
        for n, p in params.items()
        if n not in ("self", "cls")
        and p.kind
        in (
            inspect.Parameter.POSITIONAL_ONLY,
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            inspect.Parameter.KEYWORD_ONLY,
        )
    }
    return [r for r in required if r not in names]


def _check_symbol(sym: Symbol) -> tuple[bool, str | None]:
    try:
        mod = importlib.import_module(sym.module)
    except Exception as e:  # noqa: BLE001 - the precise import error is the reason
        return False, f"{sym.module}: cannot import ({type(e).__name__}: {e})"
    try:
        obj = getattr(mod, sym.name)
    except AttributeError:
        return False, f"{sym.module}.{sym.name} not found"
    missing = _missing_required_params(obj, sym.required_params)
    if missing:
        return False, f"{sym.module}.{sym.name}: parameter(s) {', '.join(repr(m) for m in missing)} not found"
    return True, None


def _grounding_weights(path: Path) -> str | None:
    """Find the weights file without instantiating the model (which would load YOLO)."""
    env_path = os.environ.get("GROUNDING_MODEL_PATH")
    candidates: list[Path] = []
    if env_path:
        candidates.append(Path(env_path))
    try:
        sys.path.insert(0, str(path))
        from dental_agent.utils.inputs import as_candidates, yolo_candidates  # type: ignore

        for cand in yolo_candidates():
            candidates.extend(as_candidates(cand))
    except Exception:  # noqa: BLE001 - fall back to the known default locations
        pass
    candidates.extend(
        [
            path / "data" / "models" / "yolo_cv_best" / "weights" / "best.pt",
            path / "data" / "models" / "dentex_grounding_tool_cv_best" / "weights" / "best.pt",
        ]
    )
    for c in candidates:
        if c and Path(c).is_file():
            return str(Path(c).resolve())
    return None


def _registry_tools(path: Path) -> tuple[list[str], str | None]:
    try:
        sys.path.insert(0, str(path))
        from dental_agent.tools.registry import ToolRegistry  # type: ignore

        registry = ToolRegistry.create_default()
        return [t.name for t in registry.list_tools()], None
    except Exception as e:  # noqa: BLE001
        return [], f"{type(e).__name__}: {e}"


def probe(path: str | Path | None = None, env: dict[str, str] | None = None) -> dict[str, Any]:
    """Return the compatibility report for one checkout. Never raises for a missing checkout."""
    env = os.environ if env is None else env
    resolved = Path(path).resolve() if path else default_path(env)
    if resolved is None or not (resolved / "dental_agent").is_dir():
        return {
            "path": None,
            "requestedPath": str(resolved) if resolved else None,
            "importable": False,
            "importError": "no VLM-DENTAL checkout found (set VLM_DENTAL_PATH)",
            "provenance": {"commit": None, "branch": None, "dirty": None},
            "python": sys.version.split()[0],
            "packages": {},
            "packageErrors": {},
            "cuda": False,
            "tools": [],
            "toolsError": "no checkout",
            "jobs": {
                job: {"available": False, "reason": "no checkout", "warnings": [], "needsTorch": False, "needsCuda": False}
                for job in JOB_DEPENDENCIES
            },
            "available": [],
            "unavailable": list(JOB_DEPENDENCIES),
            "advertisedJobs": [],
            "unknownToApp": [],
            "missingUpstream": list(APP_TOOLS),
            "groundingWeights": None,
        }

    if str(resolved) not in sys.path:
        sys.path.insert(0, str(resolved))

    packages = {name: _package_version(name) for name in OPTIONAL_PACKAGES}
    cuda = _cuda_visible()

    importable = True
    import_error: str | None = None
    try:
        importlib.import_module("dental_agent")
    except Exception as e:  # noqa: BLE001
        importable = False
        import_error = f"{type(e).__name__}: {e}"

    tools, tools_error = _registry_tools(resolved)
    weights = _grounding_weights(resolved)

    package_errors: dict[str, str] = {}

    def package_error(name: str) -> str | None:
        """Import-check a package at most once, and only when a job could otherwise run."""
        if name not in package_errors and _present(name):
            problem = _import_problem(name)
            if problem:
                package_errors[name] = problem
        return package_errors.get(name)

    jobs: dict[str, dict[str, Any]] = {}
    for job, dep in JOB_DEPENDENCIES.items():
        reasons: list[str] = []
        warnings: list[str] = []
        if not importable:
            reasons.append(f"dental_agent not importable ({import_error})")
        else:
            for sym in dep.symbols:
                ok, why = _check_symbol(sym)
                if not ok and why:
                    reasons.append(why)
        if (dep.needs_registry or dep.requires_tools) and not reasons:
            if tools_error:
                reasons.append(f"ToolRegistry unavailable ({tools_error})")
            elif dep.requires_tools:
                missing = [t for t in dep.requires_tools if t not in tools]
                if missing:
                    reasons.append(
                        "tool(s) " + ", ".join(repr(t) for t in missing) + " not in ToolRegistry"
                    )
        if dep.needs_cuda and not cuda:
            reasons.append("CUDA is not available")
        if dep.needs_grounding_weights and not weights:
            reasons.append("grounding weights file not found")
        if not reasons:
            # The expensive part: a job that is otherwise runnable is only advertised if its
            # runtime packages actually import. Skipped for already-unavailable jobs so a drifted
            # symbol does not make the probe import torch for nothing.
            for pkg in dep.packages:
                if not _present(pkg):
                    reasons.append(f"python package {pkg!r} is not installed")
                    continue
                problem = package_error(pkg)
                if problem:
                    reasons.append(f"python package {pkg!r} cannot be imported ({problem})")
            if not reasons:
                for pkg in dep.optional_packages:
                    if not _present(pkg):
                        warnings.append(f"optional python package {pkg!r} is not installed")
                        continue
                    problem = package_error(pkg)
                    if problem:
                        warnings.append(f"optional python package {pkg!r} cannot be imported ({problem})")
        jobs[job] = {
            "available": not reasons,
            "reason": "; ".join(reasons) if reasons else None,
            "warnings": warnings,
            "needsTorch": "torch" in dep.packages,
            "needsCuda": dep.needs_cuda,
        }

    available = [j for j, r in jobs.items() if r["available"]]
    advertised = list(dict.fromkeys(CAPABILITY_JOBS[j] for j in available))
    return {
        "path": str(resolved),
        "importable": importable,
        "importError": import_error,
        "provenance": provenance(resolved),
        "python": sys.version.split()[0],
        "packages": packages,
        "packageErrors": package_errors,
        "cuda": cuda,
        "tools": tools,
        "toolsError": tools_error,
        "jobs": jobs,
        "available": available,
        "unavailable": [j for j, r in jobs.items() if not r["available"]],
        "advertisedJobs": advertised,
        "unknownToApp": [t for t in tools if t not in APP_TOOLS],
        "missingUpstream": [t for t in APP_TOOLS if t not in tools],
        "groundingWeights": weights,
    }


def _failed_report(path: str | Path | None, reason: str) -> dict[str, Any]:
    """Same shape as a real report, for "the probe itself could not run"."""
    requested = str(Path(path).resolve()) if path else None
    return {
        "path": None,
        "requestedPath": requested,
        "importable": False,
        "importError": reason,
        "provenance": {"commit": None, "branch": None, "dirty": None},
        "python": sys.version.split()[0],
        "packages": {},
        "packageErrors": {},
        "cuda": False,
        "tools": [],
        "toolsError": reason,
        "jobs": {
            job: {"available": False, "reason": reason, "warnings": [], "needsTorch": False, "needsCuda": False}
            for job in JOB_DEPENDENCIES
        },
        "available": [],
        "unavailable": list(JOB_DEPENDENCIES),
        "advertisedJobs": [],
        "unknownToApp": [],
        "missingUpstream": list(APP_TOOLS),
        "groundingWeights": None,
    }


def probe_isolated(path: str | Path | None = None, timeout: float = 300.0) -> dict[str, Any]:
    """`probe()` in a fresh interpreter.

    Importing a broken native dependency (a torch build whose DLL entry point is missing, say) can
    abort a process on Windows. The worker must survive that, so it asks a child process and treats a
    crash as a report: "probe failed, no VLM jobs".
    """
    script = (
        "import json, sys;"
        "sys.path.insert(0, sys.argv[1]);"
        "import vlm_compat;"
        "sys.stdout.write('<<<REPORT>>>' + json.dumps(vlm_compat.probe(sys.argv[2] or None)))"
    )
    cmd = [sys.executable, "-c", script, str(Path(__file__).resolve().parent), str(path) if path else ""]
    try:
        r = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(Path(__file__).resolve().parent),
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as e:
        return _failed_report(path, f"probe subprocess could not run ({type(e).__name__}: {e})")
    marker = "<<<REPORT>>>"
    if r.returncode != 0 or marker not in r.stdout:
        tail = " ".join((r.stderr or "").strip().splitlines()[-2:])[:400] or "no stderr"
        return _failed_report(path, f"probe subprocess failed (exit {r.returncode}): {tail}")
    try:
        return json.loads(r.stdout.split(marker, 1)[1])
    except ValueError as e:
        return _failed_report(path, f"probe subprocess produced unreadable JSON ({e})")


def summary(report: dict[str, Any]) -> str:
    """Human-readable table for `pnpm compat` and the worker's start-up log."""
    lines: list[str] = []
    found = report.get("path")
    requested = report.get("requestedPath")
    if found:
        lines.append(f"VLM-DENTAL: {found}")
    elif requested:
        lines.append(f"VLM-DENTAL: (not found at {requested})")
    else:
        lines.append("VLM-DENTAL: (not found)")
    prov = report.get("provenance") or {}
    lines.append(
        f"provenance: commit={prov.get('commit') or '?'} branch={prov.get('branch') or '?'} "
        f"dirty={prov.get('dirty')} (provenance only; never gates behaviour)"
    )
    lines.append(f"python {report.get('python')}  cuda={report.get('cuda')}")
    pkgs = report.get("packages") or {}
    errors = report.get("packageErrors") or {}
    lines.append(
        "packages: "
        + ", ".join(f"{k}={v or '-'}{' (UNUSABLE)' if k in errors else ''}" for k, v in pkgs.items())
    )
    for name, err in errors.items():
        lines.append(f"  {name} import error: {err}")
    lines.append("jobs:")
    for job, row in (report.get("jobs") or {}).items():
        lines.append(f"  {'OK  ' if row['available'] else 'SKIP'} {job}" + ("" if row["available"] else f" - {row['reason']}"))
        for warning in row.get("warnings") or []:
            lines.append(f"       warning: {warning}")
    lines.append("advertised contract jobs: " + (", ".join(report.get("advertisedJobs") or []) or "(none)"))
    lines.append(f"tools ({len(report.get('tools') or [])}): " + ", ".join(report.get("tools") or []))
    if report.get("unknownToApp"):
        lines.append("unknown to the app (executed through the generic path): " + ", ".join(report["unknownToApp"]))
    if report.get("missingUpstream"):
        lines.append("expected by the app but missing upstream: " + ", ".join(report["missingUpstream"]))
    if report.get("groundingWeights"):
        lines.append(f"grounding weights: {report['groundingWeights']}")
    return "\n".join(lines)


def _main(argv: list[str]) -> int:
    path: str | None = None
    as_json = "--json" in argv
    if "--path" in argv:
        i = argv.index("--path")
        if i + 1 < len(argv):
            path = argv[i + 1]
    report = probe(path)
    if as_json:
        print(json.dumps(report, indent=2))
    else:
        print(summary(report))
    return 0 if report.get("path") else 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
