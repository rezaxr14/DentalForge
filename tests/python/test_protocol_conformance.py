"""Protocol conformance: replay a recorded VLM-DENTAL trace through our loop (ADR-0025).

`examples/python-worker/backends/openai_compat.py` is a deliberate line-for-line copy of the message
protocol in `dental_agent/agent/loop.py`, because SFT and GRPO were trained on those exact messages.
This test is the check that the copy did not drift:

  1. take a recorded DENTEX with-tools trace (its assistant replies are the teacher's, its
     observations are what the tools returned);
  2. feed the assistant replies to `run_loop` through `ScriptedBackend`, with a `ReplayRegistry`
     that replays the recorded tool outcomes instead of running tools;
  3. compare the conversation we build with the recorded one, message for message.

What is compared and what is not:

  * assistant messages: byte-identical;
  * observation messages: identical after mapping "the trace exporter replaced this image with a
    placeholder" to "we put the image part there" (the pixels are not in the trace);
  * the system prompt: NOT compared to the recorded text. The recorded traces predate the current
    upstream prompt (it gained a healthy-scan paragraph), so that comparison would be a drift report
    about the corpus, not about this loop. It is instead checked against upstream's own
    `build_agent_system_prompt`, and the recorded prompt is checked to list the same tools.

Traces the policy loop could not have produced are excluded, with the reason counted: trace
generation uses `langgraph_loop.py`, which rejects a final answer and caps a turn at 4 calls. Both
insert a bare-string user message that `loop.py` never writes, so the predicate is mechanical.

Skips visibly when the checkout, its traces, or the research runtime are absent. `CI_REQUIRE_VLM=1`
turns absence into a failure, as in `test_compat_contract.py`.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

import vlm_compat

ROOT = Path(__file__).resolve().parents[2]
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

TRACES = CHECKOUT / "data" / "traces" / "train_cot_traces_dentex.jsonl"
SAMPLE = 25
MIN_ELIGIBLE = 20

#: Turn statuses `langgraph_loop.py` (trace generation) emits and `loop.py` (policy rollout) does not.
TRACE_GENERATION_ONLY = {"rejected_final_answer", "invalid_tool_format"}


def _research_import_error() -> str | None:
    """Why `dental_agent.agent.loop` cannot be imported here, or None.

    A child process on purpose: on a broken native build (torchvision/peft DLL) importing in-process
    can kill pytest instead of raising, and `vlm_compat` already treats presence as != importability.
    """
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join([str(CHECKOUT), env.get("PYTHONPATH", "")]).rstrip(os.pathsep)
    r = subprocess.run(
        [sys.executable, "-c", "import dental_agent.agent.loop"],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(CHECKOUT),
        check=False,
    )
    if r.returncode == 0:
        return None
    lines = [ln for ln in (r.stderr or "").strip().splitlines() if ln.strip()]
    return lines[-1] if lines else f"exit code {r.returncode}"


@pytest.fixture(scope="module", autouse=True)
def research_runtime():
    if not TRACES.is_file():
        reason = f"recorded DENTEX traces not found: {TRACES}"
        if REQUIRE_CHECKOUT:
            pytest.fail(reason, pytrace=False)
        pytest.skip(reason)
    error = _research_import_error()
    if error:
        reason = f"research runtime not importable here: {error}"
        if REQUIRE_CHECKOUT:
            pytest.fail(reason, pytrace=False)
        pytest.skip(reason)
    if str(CHECKOUT) not in sys.path:
        sys.path.insert(0, str(CHECKOUT))


def _load(path: Path, limit: int = SAMPLE) -> list[dict]:
    out = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            if len(out) >= limit:
                break
            if line.strip():
                out.append(json.loads(line))
    return out


@pytest.fixture(scope="module")
def sample() -> list[dict]:
    return _load(TRACES)


def ineligible_reason(trace: dict) -> str | None:
    """Why `loop.py` could not have produced this trace, or None if it could."""
    for turn in trace.get("turns") or []:
        status = turn.get("status")
        if status in TRACE_GENERATION_ONLY:
            return f"turn status {status!r} comes from trace generation"
    # loop.py always appends observations as a content list; trace generation inserts hints and
    # rejections as a bare string, which loop.py never writes.
    for message in (trace.get("messages") or [])[2:]:
        if message.get("role") == "user" and not isinstance(message.get("content"), list):
            return "a user message is a bare string (a trace-generation hint/rejection)"
    return None


@pytest.fixture(scope="module")
def trace(sample: list[dict]) -> dict:
    for candidate in sample:
        if ineligible_reason(candidate) is None and candidate.get("turns"):
            return candidate
    pytest.fail("no trace in the sample could have been produced by loop.py", pytrace=False)


def _recorded_parts(content) -> list[dict]:
    """A recorded message's content as comparable parts (image placeholders become image parts)."""
    if not isinstance(content, list):
        return [{"type": "text", "text": content}]
    parts: list[dict] = []
    for part in content:
        if part.get("type") == "image":
            parts.append({"type": "image"})
        elif str(part.get("text", "")).startswith("[Earlier tool result omitted"):
            # The exporter replaces every tool image with this text; it marks an image outcome.
            parts.append({"type": "image"})
        else:
            parts.append({"type": "text", "text": part.get("text", "")})
    return parts


def _built_parts(content) -> list[dict]:
    if not isinstance(content, list):
        return [{"type": "text", "text": content}]
    return [
        {"type": "image"} if part.get("type") == "image" else {"type": "text", "text": part.get("text", "")}
        for part in content
    ]


def _replay(trace: dict):
    from PIL import Image

    from backends.mock import ScriptedBackend, replay_registry_from_trace

    registry, _ = replay_registry_from_trace(trace)
    replies = [m["content"] for m in trace["messages"] if m["role"] == "assistant"]
    backend = ScriptedBackend(replies)
    outcome = backend.run(
        registry=registry,
        image=Image.new("RGB", (16, 16), (0, 0, 0)),
        max_turns=len(replies) + 2,
    )
    return registry, outcome


def test_the_sample_still_contains_traces_the_policy_loop_could_have_produced(sample: list[dict]):
    reasons: dict[str, int] = {}
    eligible = 0
    for candidate in sample:
        reason = ineligible_reason(candidate)
        if reason is None:
            eligible += 1
        else:
            reasons[reason] = reasons.get(reason, 0) + 1
    # A drift report, not a code bug: if trace generation changes, re-read the predicate above.
    assert eligible >= MIN_ELIGIBLE, (
        f"only {eligible}/{len(sample)} recorded traces are replayable by loop.py; excluded: {reasons}"
    )


def test_the_replayed_conversation_matches_the_recorded_one(trace: dict):
    registry, outcome = _replay(trace)
    recorded = trace["messages"]
    built = outcome.messages

    assert len(built) == len(recorded), (
        f"conversation length differs: built {len(built)} messages, recorded {len(recorded)}"
    )
    for index in range(2, len(recorded)):  # 0 = system prompt (see below), 1 = first user prompt
        assert _built_parts(built[index]["content"]) == _recorded_parts(recorded[index]["content"]), (
            f"message {index} ({recorded[index]['role']}) differs from the recorded conversation"
        )

    assert [t.get("status") for t in outcome.turns] == [t.get("status") for t in trace["turns"]]
    for index, (got, want) in enumerate(zip(outcome.turns, trace["turns"])):
        got_calls = [(c.get("tool_name"), c.get("tool_ok")) for c in got.get("tool_calls_this_turn") or []]
        want_calls = [(c.get("tool_name"), c.get("tool_ok")) for c in want.get("tool_calls_this_turn") or []]
        assert got_calls == want_calls, f"turn {index}: tool calls differ from the recorded ones"

    assert outcome.n_tool_calls == len(registry.calls)
    assert outcome.final_answer is not None and outcome.format_ok is True


def test_the_trace_exercises_both_image_and_data_tools(trace: dict):
    from backends.mock import replay_registry_from_trace

    registry, _ = replay_registry_from_trace(trace)
    kinds = {outcome.kind for queue in registry._queues.values() for outcome in queue}  # noqa: SLF001
    assert {"image", "result"} <= kinds, f"trace only exercised {kinds}; the comparison would be weak"


def test_the_system_prompt_is_upstreams_builder_not_a_copy(trace: dict):
    from dental_agent.agent.prompts import build_agent_system_prompt

    from backends.mock import replay_registry_from_trace

    registry, _ = replay_registry_from_trace(trace)
    expected = build_agent_system_prompt(registry.format_tool_descriptions(), dataset="dentex")
    _, outcome = _replay(trace)
    assert outcome.messages[0]["content"] == expected

    # The recorded prompt is older than today's, so its TEXT is a drift report, not a gate. Its tool
    # list, however, must still be the tools this loop offers.
    recorded_system = trace["messages"][0]["content"]
    for name in registry.names:
        assert f"`{name}`" in recorded_system, f"recorded system prompt does not mention {name!r}"
