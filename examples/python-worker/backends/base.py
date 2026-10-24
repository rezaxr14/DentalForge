"""Shared types for the model backends (WP2).

A backend is the thing that turns an image + a cohort into a sequence of agent turns. Two real
backends exist:

  * ``torch_hf``      - VLM-DENTAL's own model/processor and ``run_agent`` loop (the research path);
  * ``openai_compat`` - an OpenAI-compatible HTTP server (LM Studio locally). TEST backend only.

``mock`` is not a model: it replays scripted assistant replies through the *same* loop code as
``openai_compat``, so tests (and the protocol-conformance test) exercise the real message protocol
without a model or a network.

Nothing here imports torch, transformers or the research package at module scope: the worker must
start and register on a machine that has neither (ADR-0024).
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable

BACKENDS = ("torch_hf", "openai_compat")
STAGES = ("base", "sft", "grpo", "test")
QUANTIZATIONS = ("nf4", "none")

#: The app's model registry has no "base" stage; a base checkpoint is the app's `zero_shot` row.
APP_STAGE = {"base": "zero_shot", "sft": "sft", "grpo": "grpo", "test": "test"}

#: One emitted turn. `data` is the app's `Turn` shape (contracts/traces.ts) plus nothing private.
TurnSink = Callable[[dict[str, Any]], None]
#: (turnIdx, callIdx, tool name, PNG bytes) for every image a tool returned during the run.
#: Returns the stored artifact id (recorded on the tool call as `artifact_id`) or None when the
#: caller does not store artifacts.
ArtifactSink = Callable[[int, int, str, bytes], str | None]


class BackendError(Exception):
    """A backend failed. `retryable` decides whether the app should try again."""

    def __init__(self, message: str, *, retryable: bool = False, code: str = "handler_error"):
        super().__init__(message)
        self.retryable = retryable
        self.code = code


class ModelUnavailable(BackendError):
    """The model server is not reachable (LM Studio closed, base path missing). Retryable."""

    def __init__(self, message: str):
        super().__init__(message, retryable=True, code="model_unavailable")


class ModelTimeout(BackendError):
    """The model did not answer in time. Retryable; turns already emitted stay visible."""

    def __init__(self, message: str):
        super().__init__(message, retryable=True, code="model_timeout")


@dataclass(frozen=True)
class ModelSpec:
    """One entry of the worker's model file (`WORKER_MODELS_FILE`), never committed with real paths."""

    model_id: str
    backend: str
    stage: str = "base"
    label: str | None = None
    #: HF id or a local directory holding safetensors (torch_hf), or the server-side model name
    #: (openai_compat, e.g. "qwen3.5-4b").
    base_path: str | None = None
    #: LoRA directory with `adapter_config.json` + `adapter_model.safetensors`.
    adapter_path: str | None = None
    #: A merged checkpoint written by `dental_agent.model.checkpoints.save_checkpoint`.
    checkpoint_dir: str | None = None
    checkpoint_tag: str | None = None
    quantization: str = "nf4"
    notes: str | None = None

    def __post_init__(self) -> None:
        if not self.model_id:
            raise ValueError("modelId must not be empty")
        if self.backend not in BACKENDS:
            raise ValueError(f"{self.model_id}: backend must be one of {BACKENDS}, got {self.backend!r}")
        if self.stage not in STAGES:
            raise ValueError(f"{self.model_id}: stage must be one of {STAGES}, got {self.stage!r}")
        if self.quantization not in QUANTIZATIONS:
            raise ValueError(
                f"{self.model_id}: quantization must be one of {QUANTIZATIONS}, got {self.quantization!r}"
            )
        if self.backend == "openai_compat":
            if not self.base_path:
                raise ValueError(f"{self.model_id}: openai_compat needs basePath (the server-side model name)")
            if self.adapter_path or self.checkpoint_dir:
                raise ValueError(f"{self.model_id}: adapters are a torch_hf feature; the test backend cannot load them")
        if self.checkpoint_dir and not self.checkpoint_tag:
            raise ValueError(f"{self.model_id}: checkpointDir needs checkpointTag")
        if self.checkpoint_tag and not self.checkpoint_dir:
            raise ValueError(f"{self.model_id}: checkpointTag needs checkpointDir")
        if self.checkpoint_dir and self.adapter_path:
            raise ValueError(f"{self.model_id}: checkpointDir (merged) and adapterPath (LoRA) are alternatives")
        if self.backend == "torch_hf" and not (self.base_path or self.checkpoint_dir):
            raise ValueError(f"{self.model_id}: torch_hf needs basePath or checkpointDir/checkpointTag")
        if self.stage in ("sft", "grpo") and not (self.adapter_path or self.checkpoint_dir):
            raise ValueError(
                f"{self.model_id}: stage {self.stage!r} means trained weights, but no adapterPath/checkpoint was given"
            )

    @property
    def app_stage(self) -> str:
        """The stage the app's registry understands (`base` is its `zero_shot`)."""
        return APP_STAGE[self.stage]

    def registry_body(self) -> dict[str, Any]:
        """Body for `POST /models/register` (upsert by name+stage; the app returns the id)."""
        meta: dict[str, Any] = {"backend": self.backend, "quantization": self.quantization, "stage": self.stage}
        if self.adapter_path:
            meta["adapterPath"] = self.adapter_path
        if self.checkpoint_dir:
            meta["checkpointDir"] = self.checkpoint_dir
            meta["checkpointTag"] = self.checkpoint_tag
        if self.notes:
            meta["notes"] = self.notes
        return {
            "name": self.model_id,
            "kind": "api" if self.backend == "openai_compat" else "vlm",
            "stage": self.app_stage,
            "hfPath": self.base_path,
            "meta": meta,
        }


@dataclass
class RunOutcome:
    """What one agent run produced, after the backend has already emitted every turn."""

    turns: list[dict[str, Any]] = field(default_factory=list)
    n_tool_calls: int = 0
    final_answer: Any = None
    format_ok: bool = False
    #: The conversation the loop built. Only used by the protocol-conformance test; never sent
    #: anywhere (the app stores turns, not the full transcript).
    messages: list[dict[str, Any]] = field(default_factory=list)

    @property
    def n_turns(self) -> int:
        return len(self.turns)


def load_models_file(path: str | Path | None) -> list[ModelSpec]:
    """Parse `WORKER_MODELS_FILE`. Unset/empty -> no models (the worker still registers).

    A malformed file is a start-up error, not a silent empty list: a worker that serves no model
    while the owner believes it does is worse than a worker that refuses to start.
    """
    if not path:
        return []
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    entries = raw.get("models") if isinstance(raw, dict) else None
    if not isinstance(entries, list):
        raise ValueError(f"{path}: expected an object with a 'models' array")
    specs: list[ModelSpec] = []
    seen: set[str] = set()
    for i, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise ValueError(f"{path}: models[{i}] is not an object")
        try:
            spec = ModelSpec(
                model_id=str(entry.get("modelId") or ""),
                backend=str(entry.get("backend") or ""),
                stage=str(entry.get("stage") or "base"),
                label=entry.get("label"),
                base_path=entry.get("basePath"),
                adapter_path=entry.get("adapterPath"),
                checkpoint_dir=entry.get("checkpointDir"),
                checkpoint_tag=entry.get("checkpointTag"),
                quantization=str(entry.get("quantization") or "nf4"),
                notes=entry.get("notes"),
            )
        except ValueError as e:
            raise ValueError(f"{path}: models[{i}]: {e}") from e
        if spec.model_id in seen:
            raise ValueError(f"{path}: duplicate modelId {spec.model_id!r}")
        seen.add(spec.model_id)
        specs.append(spec)
    return specs


def tolerant_findings(answer: Any) -> list[dict[str, Any]]:
    """Turn a model's final answer into the app's `PredictedFinding[]` (ADR-0014), never raising.

    The model may answer with a single object (the prompt asks for a list), may put a whole FDI code
    in `tooth_position`, may emit `confidence: null`, or may emit something that is not a finding at
    all. Findings are kept as emitted - the point of the tolerant class is that a wrong answer is
    *representable* and therefore scored, not dropped. Entries that are not objects are dropped (they
    cannot be represented); that is the only lossy step, and `format_ok` already reports it upstream.
    """
    if answer is None:
        return []
    items = answer if isinstance(answer, list) else [answer]
    out: list[dict[str, Any]] = []
    for item in items:
        if isinstance(item, dict):
            out.append(dict(item))
    return out


def iter_assistant_messages(messages: Iterable[dict[str, Any]]) -> list[str]:
    """The raw assistant replies of a recorded trace, in order (protocol-conformance replay)."""
    return [m["content"] for m in messages if m.get("role") == "assistant" and isinstance(m.get("content"), str)]
