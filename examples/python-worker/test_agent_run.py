"""`agent.run` handler: model resolution, events, payload passthrough, result shape.

The loop and the backends are fakes here; `test_backends.py` covers them and
`tests/python/test_protocol_conformance.py` checks the loop against a recorded trace.
"""
from __future__ import annotations

from typing import Any

import pytest
from PIL import Image

from agent_run import make_agent_run
from backends.base import ModelSpec, ModelUnavailable, RunOutcome
from worker_errors import NonRetryable

IMG = Image.new("RGB", (20, 10), (1, 2, 3))


class FakeClient:
    """The two contract calls a live run makes: image metadata, then trace ingest."""

    def __init__(self, meta: dict | None = None, ingest: dict | None = None):
        self.meta = meta if meta is not None else {}
        self.ingest = ingest if ingest is not None else {
            "results": [{"index": 0, "imageId": 1, "outcome": "inserted", "traceId": "00000000-0000-4000-8000-0000000000aa"}],
            "inserted": 1, "existing": 0, "rejected": 0,
        }
        self.posts: list[tuple[str, Any]] = []

    def get(self, path: str) -> dict:
        return self.meta

    def post(self, path: str, body: Any) -> dict:
        self.posts.append((path, body))
        return self.ingest


class Ctx:
    def __init__(self, payload: dict, *, stopped: bool = False, meta: dict | None = None, ingest: dict | None = None):
        self.job = {"id": "job-1", "type": "agent.run", "payload": payload, "attempt": 1}
        self.events: list[tuple[str, Any]] = []
        self.uploads: list[tuple[str, str, bytes]] = []
        self.client = FakeClient(meta=meta, ingest=ingest)
        import threading

        self.abort = threading.Event()
        if stopped:
            self.abort.set()

    def emit(self, type_: str, data: Any) -> None:
        self.events.append((type_, data))

    def upload(self, name: str, mime: str, data: bytes) -> str:
        self.uploads.append((name, mime, data))
        return "00000000-0000-4000-8000-00000000000%d" % len(self.uploads)


class FakeOpenAI:
    def __init__(self):
        self.models: list[str] = []
        self.replies = 0

    def completer(self, model: str):
        self.models.append(model)

        def complete(messages: list[dict], **kwargs: Any) -> str:
            self.replies += 1
            return "{}"

        return complete


class FakeTorch:
    def __init__(self, outcome: RunOutcome | None = None):
        self.calls: list[dict] = []
        self.outcome = outcome or RunOutcome(turns=[{"turn": 0, "status": "final_answer"}], n_tool_calls=1,
                                             final_answer=[{"quadrant": 1, "tooth_position": 1, "diagnosis": "Caries"}],
                                             format_ok=True)

    def run(self, spec: ModelSpec, **kwargs: Any) -> RunOutcome:
        self.calls.append({"spec": spec, **kwargs})
        for turn in self.outcome.turns:
            kwargs["on_turn"](turn)
        return self.outcome


def spec(**kw: Any) -> ModelSpec:
    base: dict[str, Any] = {"model_id": "m", "backend": "openai_compat", "stage": "test", "base_path": "qwen3.5-4b"}
    base.update(kw)
    return ModelSpec(**base)


def handler(models: dict[str, ModelSpec] | None = None, *, torch: Any = None, loop: Any = None, openai: Any = None):
    return make_agent_run(
        models=models if models is not None else {"model-uuid": spec()},
        torch_backend=torch,
        openai_backend=openai or FakeOpenAI(),
        load_image=lambda ctx, image_id: IMG,
        registry_factory=lambda: "registry",
        run_loop=loop,
    )


def test_an_unknown_model_is_refused_and_names_what_is_served():
    h = handler({"a-uuid": spec(model_id="base")})
    with pytest.raises(NonRetryable, match="does not serve model 'nope'.*base"):
        h(Ctx({"imageId": 1, "modelId": "nope", "mode": "with_tools"}))


def test_a_torch_model_without_the_backend_is_refused_not_guessed():
    h = handler({"u": spec(model_id="base", backend="torch_hf", stage="base")}, torch=None)
    with pytest.raises(NonRetryable, match="needs the torch_hf backend"):
        h(Ctx({"imageId": 1, "modelId": "u", "mode": "with_tools"}))


def test_an_unknown_mode_is_refused():
    with pytest.raises(NonRetryable, match="mode must be"):
        handler()(Ctx({"imageId": 1, "modelId": "model-uuid", "mode": "both"}))


def test_the_openai_loop_receives_a_completer_bound_to_the_served_model():
    """Regression: the loop calls `complete(messages, temperature=...)`; `model` is the backend's."""
    seen: dict[str, Any] = {}

    def loop(complete, *, registry, image, **kwargs):
        seen["model"] = complete([{"role": "user", "content": "hi"}], temperature=0.4)
        return RunOutcome()

    fake = FakeOpenAI()
    handler(loop=loop, openai=fake)(Ctx({"imageId": 1, "modelId": "model-uuid", "mode": "with_tools"}))
    assert fake.models == ["qwen3.5-4b"]  # the spec's basePath, not a hard-coded name
    assert fake.replies == 1 and seen["model"] == "{}"


def test_the_openai_path_emits_progress_turns_and_artifacts_and_a_tolerant_result():
    def loop(complete, *, registry, image, **kwargs):
        assert registry == "registry"
        kwargs["on_turn"]({"turn": 0, "status": "tool_executed", "parsed": {"tool_calls": []}})
        kwargs["on_artifact"](0, 1, "zoom_crop", b"\x89PNG\r\n\x1a\n")
        kwargs["on_turn"](
            {
                "turn": 1,
                "status": "final_answer",
                "raw_output": '{"final_answer": {...}}',
                # a single object: the loop accepts it, the contract needs a list
                "parsed": {"final_answer": {"quadrant": 3, "tooth_position": 36, "diagnosis": "Caries"}},
            }
        )
        return RunOutcome(turns=[{}, {}], n_tool_calls=1,
                          final_answer={"quadrant": 3, "tooth_position": 36, "diagnosis": "Caries"}, format_ok=True)

    ctx = Ctx({"imageId": 1, "modelId": "model-uuid", "mode": "with_tools"})
    result = handler(loop=loop)(ctx)

    kinds = [k for k, _ in ctx.events]
    assert kinds == ["progress", "turn", "artifact", "turn"]
    progress = ctx.events[0][1]
    assert progress["backend"] == "openai_compat" and progress["stage"] == "test"
    assert progress["turnsStreamed"] is True and "not the research model" in progress["note"]
    # the stored turn is schema-shaped: final_answer is a list, the raw output is untouched
    assert ctx.events[3][1]["parsed"]["final_answer"] == [{"quadrant": 3, "tooth_position": 36, "diagnosis": "Caries"}]
    assert ctx.events[3][1]["raw_output"] == '{"final_answer": {...}}'
    assert ctx.events[2][1] == {
        "turnIdx": 0, "callIdx": 1, "artifactId": "00000000-0000-4000-8000-000000000001",
        "name": "zoom_crop_0_1.png", "mime": "image/png",
    }
    assert ctx.uploads[0][0] == "zoom_crop_0_1.png" and ctx.uploads[0][1] == "image/png"
    assert result == {
        "finalAnswer": [{"quadrant": 3, "tooth_position": 36, "diagnosis": "Caries"}],
        "nTurns": 2, "nToolCalls": 1, "formatOk": True,
    }
    assert "rewardComponents" not in result


def test_the_payload_settings_reach_the_loop():
    seen: dict[str, Any] = {}

    def loop(complete, *, registry, image, **kwargs):
        seen.update(kwargs)
        return RunOutcome()

    ctx = Ctx({
        "imageId": 4, "modelId": "model-uuid", "mode": "with_tools",
        "maxTurns": 7, "maxToolCalls": 9, "canonicalResize": True, "temperature": 0.4, "seed": 11,
    })
    handler(loop=loop)(ctx)
    assert seen["max_turns"] == 7 and seen["max_tool_calls"] == 9
    assert seen["canonical_resize"] is True and seen["temperature"] == 0.4 and seen["seed"] == 11
    assert seen["should_stop"] == ctx.abort.is_set


def test_no_tools_mode_does_not_need_a_registry():
    seen: dict[str, Any] = {}

    def loop(complete, *, registry, image, **kwargs):
        seen["registry"] = registry
        return RunOutcome(turns=[{}], final_answer=[], format_ok=True)

    handler(loop=loop)(Ctx({"imageId": 1, "modelId": "model-uuid", "mode": "no_tools"}))
    assert seen["registry"] is None


def test_the_torch_path_passes_the_cohort_and_settings_and_streams_at_completion():
    torch = FakeTorch()
    h = handler({"u": spec(model_id="base", backend="torch_hf", stage="base")}, torch=torch)
    ctx = Ctx({"imageId": 3, "modelId": "u", "mode": "no_tools", "maxTurns": 2, "maxToolCalls": 4})
    result = h(ctx)
    call = torch.calls[0]
    assert call["mode"] == "no_tools" and call["max_turns"] == 2 and call["max_tool_calls"] == 4
    assert call["image_id"] == 3 and call["spec"].model_id == "base"
    assert [k for k, _ in ctx.events] == ["progress", "turn"]
    assert ctx.events[0][1]["turnsStreamed"] is False
    assert result["nTurns"] == 1 and result["nToolCalls"] == 1


def test_a_dead_model_server_stays_retryable_through_the_handler():
    def loop(complete, **kwargs):
        raise ModelUnavailable("model server at http://localhost:1234/v1 is unreachable")

    with pytest.raises(ModelUnavailable) as e:
        handler(loop=loop)(Ctx({"imageId": 1, "modelId": "model-uuid", "mode": "with_tools"}))
    assert e.value.retryable is True and e.value.code == "model_unavailable"


def test_a_cancelled_job_is_not_started():
    torch = FakeTorch()
    h = handler({"u": spec(model_id="base", backend="torch_hf", stage="base")}, torch=torch)
    h(Ctx({"imageId": 1, "modelId": "u", "mode": "with_tools"}, stopped=True))
    assert torch.calls[0]["should_stop"]() is True


# ---- live trace ingestion (ADR-0025) --------------------------------------

META = {
    "sourceImageId": 18,
    "datasetId": "00000000-0000-4000-8000-0000000000dd",
    "dataset": "dentex",
    "split": "val",
    "groundTruth": [{"quadrant": 1, "tooth_position": 8, "diagnosis": "Caries", "bbox": [1, 2, 3, 4]}],
}


def _loop_with_artifact(tool_name: str = "zoom_crop"):
    def loop(complete, *, registry, image, **kwargs):
        artifact_id = kwargs["on_artifact"](0, 0, tool_name, b"\x89PNG\r\n\x1a\n")
        call = {"tool_name": tool_name, "tool_args": {}, "tool_ok": True, "artifact_id": artifact_id}
        turns = [
            {"turn": 0, "status": "tool_executed", "tool_calls_this_turn": [call]},
            {"turn": 1, "status": "final_answer", "parsed": {"final_answer": []}},
        ]
        for turn in turns:
            kwargs["on_turn"](turn)
        return RunOutcome(turns=turns, n_tool_calls=1, final_answer=[], format_ok=True)

    return loop


def test_a_live_run_is_stored_as_a_trace_with_backend_stage_and_artifact_ids():
    ctx = Ctx(
        {"imageId": "00000000-0000-4000-8000-0000000000bb", "modelId": "model-uuid", "mode": "with_tools"},
        meta=META,
    )
    result = handler(loop=_loop_with_artifact())(ctx)

    assert result["traceId"] == "00000000-0000-4000-8000-0000000000aa"
    path, body = ctx.client.posts[0]
    assert path == "/ingest/traces"
    source = body["source"]
    assert source == {
        "cohort": "m",  # the spec's model_id, slugged
        "mode": "with_tools",
        "verified": False,
        "sourceFile": "agent.run:openai_compat:test",
        "backend": "openai_compat",
        "stage": "test",
    }
    trace = body["traces"][0]
    assert trace["image_id"] == 18 and trace["dataset"] == "dentex"
    assert trace["ground_truth"] == META["groundTruth"]
    assert trace["tool_calls"] == 1 and trace["format_ok"] is True
    assert trace["turns"][0]["tool_calls_this_turn"][0]["artifact_id"] == "00000000-0000-4000-8000-000000000001"
    assert "messages" not in trace


def test_an_image_without_known_ground_truth_is_not_stored_and_the_run_still_succeeds():
    ctx = Ctx(
        {"imageId": "00000000-0000-4000-8000-0000000000bb", "modelId": "model-uuid", "mode": "with_tools"},
        meta={**META, "groundTruth": None},
    )
    result = handler(loop=_loop_with_artifact())(ctx)
    assert ctx.client.posts == []
    assert "traceId" not in result


def test_a_rejected_trace_fails_the_job_instead_of_silently_losing_it():
    ctx = Ctx(
        {"imageId": "00000000-0000-4000-8000-0000000000bb", "modelId": "model-uuid", "mode": "with_tools"},
        meta=META,
        ingest={"results": [{"index": 0, "imageId": 18, "outcome": "rejected", "reason": "unknown_image"}],
                "inserted": 0, "existing": 0, "rejected": 1},
    )
    with pytest.raises(NonRetryable, match="rejected this run's trace: unknown_image"):
        handler(loop=_loop_with_artifact())(ctx)


def test_a_cohort_is_a_valid_slug_and_never_the_union_label():
    from agent_run import _cohort

    assert _cohort("Qwen3.5-4B") == "qwen3_5_4b"
    assert _cohort("hybrid") == "live_model"
    assert _cohort("") == "live"
    assert len(_cohort("x" * 100)) == 64
    assert _cohort("...").startswith("live")


def test_an_unnamed_tool_call_is_stored_with_an_empty_name_not_dropped():
    from agent_run import _normalise_turn

    turn = _normalise_turn(
        {"turn": 0, "tool_calls_this_turn": [{"tool_name": None, "tool_ok": False, "tool_error": "not recognized"}]}
    )
    assert turn["tool_calls_this_turn"][0]["tool_name"] == ""
    assert turn["tool_calls_this_turn"][0]["tool_error"] == "not recognized"
