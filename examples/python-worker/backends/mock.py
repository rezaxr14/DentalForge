"""A deterministic backend: scripted assistant replies through the real loop.

Two uses, no network and no torch:

  * tests: every failure mode of `agent.run` (malformed JSON, unknown tool, tool exception, budget,
    stop/cancel) is reproducible;
  * `tests/python/test_protocol_conformance.py`: replay the assistant replies of a recorded
    VLM-DENTAL trace through the *same* `run_loop` and compare the messages we build with the ones
    the trace recorded. A mismatch means this loop drifted from the protocol SFT/GRPO trained on.

`ReplayRegistry` is the second half of that test: instead of executing tools it returns what the
recorded trace shows, so the comparison isolates the loop's message construction from the tools.
Outcomes are queued **per tool name** and consumed in call order: a trace calls `locate_tooth` for
many different teeth with different boxes, so keying a single result per name would replay the wrong
one from the second call onwards.
"""
from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Iterable

from .base import BackendError
from .openai_compat import run_loop

DUMMY_IMAGE_SIZE = (8, 8)

#: What langgraph_loop writes where an image used to be when it trims context before generation.
#: The exported traces replace every tool image with this text, so it marks an image outcome.
OMITTED_IMAGE_MARKER = "[Earlier tool result omitted"


@dataclass
class RecordedOutcome:
    """One thing a tool did in a recorded trace: return an image, return data, or raise."""

    kind: str  # "image" | "result" | "error"
    value: Any = None


class ScriptedBackend:
    """`complete()` that returns prepared replies in order and remembers what it was asked."""

    def __init__(self, replies: Iterable[str], *, fail_at: int | None = None, error: Exception | None = None):
        self.replies = list(replies)
        self.seen: list[list[dict[str, Any]]] = []
        self.temperatures: list[float] = []
        self.seeds: list[int | None] = []
        self.fail_at = fail_at
        self.error = error

    def __call__(self, messages: list[dict[str, Any]], *, temperature: float = 0.0, seed: int | None = None) -> str:
        # Snapshot, not a reference: the loop keeps appending to `messages`, so a stored reference
        # would show the END of the run rather than what this call actually received.
        self.seen.append(
            [
                {**m, "content": list(m["content"]) if isinstance(m.get("content"), list) else m.get("content")}
                for m in messages
            ]
        )
        self.temperatures.append(temperature)
        self.seeds.append(seed)
        index = len(self.seen) - 1
        if self.fail_at is not None and index == self.fail_at:
            raise self.error or BackendError("scripted failure")
        if index >= len(self.replies):
            raise BackendError(f"scripted backend ran out of replies at turn {index}")
        return self.replies[index]

    def run(self, **kwargs: Any):
        return run_loop(self, **kwargs)


class _Tool:
    def __init__(self, name: str):
        self.name = name


class ReplayRegistry:
    """Minimal registry whose tools replay recorded outcomes, in call order, per tool name."""

    def __init__(
        self,
        results: dict[str, Any] | None = None,
        errors: dict[str, str] | None = None,
        image_tools: Iterable[str] | None = None,
        names: Iterable[str] | None = None,
        outcomes: dict[str, list[RecordedOutcome]] | None = None,
    ):
        self._queues: dict[str, list[RecordedOutcome]] = {k: list(v) for k, v in (outcomes or {}).items()}
        for name, value in (results or {}).items():
            self._queues.setdefault(name, []).append(RecordedOutcome("result", value))
        for name, message in (errors or {}).items():
            self._queues.setdefault(name, []).append(RecordedOutcome("error", message))
        for name in image_tools or ():
            self._queues.setdefault(name, []).append(RecordedOutcome("image"))
        self.names = list(names or sorted(self._queues))
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def list_tools(self) -> list[_Tool]:
        return [_Tool(n) for n in self.names]

    def format_tool_descriptions(self) -> str:
        return "\n".join(f"- {n}: replay stub" for n in self.names)

    def get(self, name: str) -> _Tool | None:
        return _Tool(name) if name in self.names else None

    def execute(self, name: str, **kwargs: Any) -> Any:
        self.calls.append((name, kwargs))
        queue = self._queues.get(name)
        if not queue:
            raise RuntimeError(f"no recorded outcome left for {name}")
        outcome = queue.pop(0)
        if outcome.kind == "error":
            raise RuntimeError(outcome.value)
        if outcome.kind == "image":
            from PIL import Image

            return Image.new("RGB", DUMMY_IMAGE_SIZE, (0, 0, 0))
        return outcome.value


def observations_from_messages(messages: list[dict[str, Any]]) -> list[list[tuple[str, str | None]]]:
    """Every user message with parts, as `[(kind, text_or_None), ...]` (kind is text|image)."""
    out: list[list[tuple[str, str | None]]] = []
    for m in messages:
        if m.get("role") != "user" or not isinstance(m.get("content"), list):
            continue
        parts: list[tuple[str, str | None]] = []
        for part in m["content"]:
            if part.get("type") == "image":
                parts.append(("image", None))
            elif part.get("type") == "text":
                parts.append(("text", part.get("text", "")))
        out.append(parts)
    return out


def _outcome_from_parts(parts: list[tuple[str, str | None]], index: int, name: str) -> tuple[RecordedOutcome, int]:
    """Read the recorded outcome of one tool call, returning it and the next part index."""
    if index >= len(parts):
        raise AssertionError(f"recorded trace has no observation for a call to {name!r}")
    kind, text = parts[index]
    if kind == "image":
        return RecordedOutcome("image"), index + 2  # image part + "Result of <tool>:"
    if text is None:  # pragma: no cover - observations are text or image
        raise AssertionError(f"unreadable observation for {name!r}")
    if text.startswith(OMITTED_IMAGE_MARKER) or text == f"Result of {name}:":
        # The trace exporter replaced the image with a placeholder; the following part is the label.
        return RecordedOutcome("image"), index + (2 if text.startswith(OMITTED_IMAGE_MARKER) else 1)
    prefix = f"Result of {name}: "
    if text.startswith(prefix):
        payload = text[len(prefix) :]
        try:
            return RecordedOutcome("result", json.loads(payload)), index + 1
        except (ValueError, TypeError):
            return RecordedOutcome("result", payload), index + 1
    if text.startswith("Error: Tool "):
        # The tool was not registered, so it never ran: it must stay unregistered in the replay too.
        return RecordedOutcome("unknown", None), index + 1
    failed = f"Tool '{name}' execution failed: "
    if text.startswith(failed):
        return RecordedOutcome("error", text[len(failed) :]), index + 1
    raise AssertionError(f"unrecognised observation for {name!r}: {text[:120]!r}")


def replay_registry_from_trace(
    trace: dict[str, Any],
) -> tuple[ReplayRegistry, list[list[tuple[str, str | None]]]]:
    """Build a `ReplayRegistry` from a recorded trace's own observations.

    Returns the registry and the recorded observations, in order. The trace's `messages` have had
    every tool image replaced by `OMITTED_IMAGE_MARKER`, so an image outcome is recognised by that
    marker (or by a bare `Result of <tool>:` label when the image was dropped entirely).
    """
    observed = observations_from_messages(trace.get("messages") or [])
    outcomes: dict[str, list[RecordedOutcome]] = defaultdict(list)
    # observed[0] is the first user message (image + prompt), not a tool observation.
    obs_index = 1
    for turn in trace.get("turns") or []:
        calls = turn.get("tool_calls_this_turn") or []
        if not calls:
            continue
        if obs_index >= len(observed):
            raise AssertionError(f"trace has {len(calls)} call(s) but no observation left")
        parts = observed[obs_index]
        obs_index += 1
        part_index = 0
        for call in calls:
            name = call.get("tool_name")
            if not name:  # a malformed entry the model emitted; loop.py records it as unrecognised
                part_index += 1
                continue
            outcome, part_index = _outcome_from_parts(parts, part_index, name)
            if outcome.kind != "unknown":
                outcomes[name].append(outcome)
        if part_index != len(parts):
            raise AssertionError(
                f"trace observation has {len(parts) - part_index} part(s) no call accounts for"
            )
    return ReplayRegistry(outcomes=dict(outcomes)), observed
