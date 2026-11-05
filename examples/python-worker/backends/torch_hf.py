"""The real backend: VLM-DENTAL's own Qwen backbone + `run_agent` loop.

Design points that matter:

  * **Lazy, resident, serialized.** The model is loaded on the first `agent.run` and kept until an
    idle timeout. Loading a 9B model is expensive and must never happen at worker start-up; GPU jobs
    are serialized by one lock so two jobs cannot interleave on one card.
  * **No new weights code.** The base comes from `dental_agent.model.backbone.load_model` (4-bit NF4
    when CUDA is present), a LoRA adapter from `peft.PeftModel.from_pretrained`, or a merged
    checkpoint from `dental_agent.model.checkpoints.load_checkpoint`. Nothing here reimplements
    loading.
  * **The loop is upstream's.** `run_agent` / `run_agent_no_tools` are called directly, so the
    cohort switch and the tool-call budget are the research settings, not a copy.
  * **Turns are delivered at completion.** Upstream has no per-turn hook, so this backend emits
    every `turn` event after the run returns. The UI says so (ADR-0025). An optional progress tap on
    `generate_agent_reply` is not installed by default: it mutates a module the research code owns
    and its only benefit is cosmetic.
  * **No tool images.** `AgentTrajectory` records tool calls but not the images tools returned, so
    this backend cannot upload them. `trace.render_artifacts` (WP3) re-executes the calls on demand.
"""
from __future__ import annotations

import dataclasses
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable

from .base import ArtifactSink, BackendError, ModelUnavailable, RunOutcome, TurnSink

#: Seconds a loaded model may sit idle before it is released (0 disables unloading).
DEFAULT_IDLE_UNLOAD_S = 600


def _default_registry() -> Any:
    """The real tool registry. Imported here (not at module scope) so the worker starts without it."""
    from dental_agent.tools.registry import ToolRegistry

    return ToolRegistry.create_default()


class TorchHFBackend:
    """Loads and runs VLM-DENTAL's model. `loader`/`runner` are injectable so tests need no torch."""

    def __init__(
        self,
        *,
        checkout: str | Path | None = None,
        config_path: str | Path | None = None,
        idle_unload_s: float | None = None,
        loader: Callable[["Any"], tuple[Any, Any]] | None = None,
        checkpoint_loader: Callable[["Any"], tuple[Any, Any]] | None = None,
        runner: Callable[..., Any] | None = None,
        no_tools_runner: Callable[..., Any] | None = None,
        images_df_factory: Callable[[Any, Path], Any] | None = None,
        registry_factory: Callable[[], Any] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.checkout = Path(checkout) if checkout else None
        self.config_path = config_path or os.environ.get("VLM_DENTAL_CONFIG")
        self.idle_unload_s = (
            float(idle_unload_s)
            if idle_unload_s is not None
            else float(os.environ.get("WORKER_MODEL_IDLE_UNLOAD_S", DEFAULT_IDLE_UNLOAD_S))
        )
        self._loader = loader
        self._checkpoint_loader = checkpoint_loader
        self._runner = runner
        self._no_tools_runner = no_tools_runner
        self._images_df = images_df_factory or _images_df
        self._registry_factory = registry_factory
        self._clock = clock
        # Re-entrant: `run` holds it for the whole job (GPU jobs are serialized) and calls
        # `ensure_loaded`, which must not deadlock on the same lock.
        self._lock = threading.RLock()
        self._loaded_key: str | None = None
        self._model: Any = None
        self._processor: Any = None
        self._last_used = 0.0

    # ------------------------------------------------------------------ loading
    def _spec_key(self, spec: Any) -> str:
        # Everything that decides WHICH model is resident. `model_id` matters even when two entries
        # point at the same weights: the app asked for a different registered model, so it must not
        # silently get the previous one's in-memory state.
        return "|".join(
            str(x or "")
            for x in (
                spec.model_id,
                spec.stage,
                spec.base_path,
                spec.adapter_path,
                spec.checkpoint_dir,
                spec.checkpoint_tag,
                spec.quantization,
            )
        )

    def _resolve_config(self) -> Any:
        from dental_agent.config import load_config

        path = self.config_path
        if path is None:
            root = self.checkout or _checkout_from_env()
            if root is not None:
                candidate = Path(root) / "configs" / "default.yaml"
                if candidate.is_file():
                    path = str(candidate)
        return load_config(path) if path else load_config(None)

    def _load(self, spec: Any) -> tuple[Any, Any]:
        if self._loader is not None and not spec.checkpoint_dir:
            return self._loader(spec)
        if spec.checkpoint_dir:
            if self._checkpoint_loader is not None:
                return self._checkpoint_loader(spec)
            from dental_agent.model.checkpoints import load_checkpoint

            return load_checkpoint(spec.checkpoint_dir, spec.checkpoint_tag)

        from dental_agent.model.backbone import load_model

        cfg = self._resolve_config()
        cfg.model = dataclasses.replace(
            cfg.model,
            name=spec.base_path,
            load_in_4bit=(spec.quantization == "nf4"),
        )
        model, processor = load_model(cfg)
        if spec.adapter_path:
            model = _apply_adapter(model, spec.adapter_path)
        return model, processor

    def ensure_loaded(self, spec: Any) -> tuple[Any, Any]:
        """Return (model, processor), loading lazily and unloading an idle model first."""
        key = self._spec_key(spec)
        with self._lock:
            if self._model is not None and self._loaded_key != key:
                self._release()
            if self._model is not None and self._idle_expired():
                self._release()
            if self._model is None:
                try:
                    self._model, self._processor = self._load(spec)
                except FileNotFoundError as e:
                    raise ModelUnavailable(f"model weights not found for {spec.model_id}: {e}") from e
                except Exception as e:  # noqa: BLE001 - a broken install is retryable after a fix
                    raise ModelUnavailable(f"could not load {spec.model_id}: {type(e).__name__}: {e}") from e
                self._loaded_key = key
            self._last_used = self._clock()
            return self._model, self._processor

    def _idle_expired(self) -> bool:
        return self.idle_unload_s > 0 and (self._clock() - self._last_used) > self.idle_unload_s

    def _release(self) -> None:
        self._model = None
        self._processor = None
        self._loaded_key = None
        try:  # release GPU memory when torch is present; tests never get here
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001 - unloading is best-effort
            pass

    def unload(self) -> None:
        with self._lock:
            self._release()

    # ------------------------------------------------------------------ running
    def run(
        self,
        spec: Any,
        *,
        image: Any,
        image_id: int,
        mode: str = "with_tools",
        max_turns: int | None = None,
        max_tool_calls: int = 50,
        canonical_resize: bool = False,
        temperature: float = 0.0,
        seed: int | None = None,
        on_turn: TurnSink | None = None,
        on_artifact: ArtifactSink | None = None,
        should_stop: Callable[[], bool] | None = None,
    ) -> RunOutcome:
        if should_stop is not None and should_stop():
            return RunOutcome()
        with self._lock:  # one GPU job at a time; also keeps an idle unload from racing a run
            model, processor = self.ensure_loaded(spec)
            if seed is not None:
                try:
                    import torch

                    torch.manual_seed(seed)
                except Exception:  # noqa: BLE001 - seeding is best-effort, never fatal
                    pass

            run_agent, run_agent_no_tools = self._runners()
            with tempfile.TemporaryDirectory(prefix="tf-agent-") as tmp:
                path = Path(tmp) / f"{image_id}.png"
                image.save(path, format="PNG")
                images_df = self._images_df(image_id, path)
                kwargs: dict[str, Any] = {
                    "image_id": image_id,
                    "images_df": images_df,
                    "model": model,
                    "processor": processor,
                    "verbose": False,
                    "canonical_resize": canonical_resize,
                    "temperature": temperature,
                }
                if mode == "no_tools":
                    trajectory = run_agent_no_tools(**kwargs)
                else:
                    registry = self._registry_factory() if self._registry_factory else _default_registry()
                    trajectory = run_agent(
                        **kwargs,
                        registry=registry,
                        max_tool_calls=max_tool_calls,
                        max_turns=max_turns,
                    )

        turns = list(trajectory.turns)
        for turn in turns:
            if on_turn is not None:
                on_turn(turn)
        return RunOutcome(
            turns=turns,
            n_tool_calls=trajectory.tool_calls,
            final_answer=trajectory.final_answer,
            format_ok=trajectory.format_ok,
            messages=list(getattr(trajectory, "messages", []) or []),
        )

    def _runners(self) -> tuple[Callable[..., Any], Callable[..., Any]]:
        if self._runner is not None:
            return self._runner, self._no_tools_runner or self._runner
        from dental_agent.agent.loop import run_agent, run_agent_no_tools

        return run_agent, run_agent_no_tools


def _images_df(image_id: int, path: Path) -> Any:
    """The one-row frame `loop.py` reads: it does `images_df[images_df["id"] == image_id].iloc[0]`."""
    import pandas as pd

    return pd.DataFrame([{"id": image_id, "local_path": str(path)}])


def _apply_adapter(model: Any, adapter_path: str) -> Any:
    # Check the directory first: "the path is wrong" is the common mistake and must be reported as
    # such even on a machine where `peft` itself is broken (the venv currently is).
    if not (Path(adapter_path) / "adapter_config.json").is_file():
        raise BackendError(f"adapterPath {adapter_path!r} has no adapter_config.json")
    try:
        from peft import PeftModel
    except ImportError as e:
        raise BackendError(
            f"adapterPath {adapter_path!r} needs the 'peft' package, which this worker cannot import: {e}"
        ) from e
    return PeftModel.from_pretrained(model, adapter_path)


def _checkout_from_env() -> Path | None:
    raw = os.environ.get("VLM_DENTAL_PATH")
    return Path(raw) if raw else None
