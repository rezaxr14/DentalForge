"""Backends: model-file parsing, the tolerant final answer, the loop's failure modes, torch_hf wiring.

No torch, no transformers, no network: the loaders/runners/HTTP clients/registry are injected. The
loop itself IS upstream's parser, prompts and tool dispatch (that is the guarantee), so the tests
that execute it need VLM-DENTAL on PYTHONPATH and skip visibly without it; the torch tests inject
every upstream seam and run anywhere. `tests/python/test_protocol_conformance.py` is the end-to-end
check against a recorded trace and also needs the checkout.
"""
from __future__ import annotations

import io
import importlib.util
import json
import types
from typing import Any

import pytest
from PIL import Image

from backends.base import (
    BackendError,
    ModelSpec,
    ModelTimeout,
    ModelUnavailable,
    load_models_file,
    tolerant_findings,
)
from backends.mock import ScriptedBackend, ReplayRegistry
from backends.openai_compat import OpenAICompatBackend, run_loop, to_openai_messages
from backends.torch_hf import TorchHFBackend

IMG = Image.new("RGB", (40, 30), (5, 6, 7))

#: The loop IS upstream's parser/prompts/dispatch (that is the point of the copy), so its tests need
#: the research package. CI installs only pytest+pillow; these skip visibly there and run in the
#: weekly upstream-compat job and on a machine with the checkout. Everything else in this file is
#: dependency-free.
HAS_RESEARCH = importlib.util.find_spec("dental_agent") is not None
requires_research = pytest.mark.skipif(
    not HAS_RESEARCH, reason="needs VLM-DENTAL on PYTHONPATH (upstream parser/prompts/tool dispatch)"
)


# ------------------------------------------------------------------ model file
def write_models(tmp_path: Any, payload: Any) -> str:
    p = tmp_path / "models.json"
    p.write_text(json.dumps(payload), encoding="utf-8")
    return str(p)


def test_model_file_maps_base_to_zero_shot_and_kind_to_backend(tmp_path: Any):
    path = write_models(
        tmp_path,
        {
            "models": [
                {"modelId": "base", "backend": "torch_hf", "stage": "base", "basePath": "Qwen/Qwen3.5-9B"},
                {"modelId": "lm", "backend": "openai_compat", "stage": "test", "basePath": "qwen3.5-4b"},
            ]
        },
    )
    base, lmstudio = load_models_file(path)
    assert base.app_stage == "zero_shot" and base.registry_body()["kind"] == "vlm"
    assert lmstudio.app_stage == "test" and lmstudio.registry_body()["kind"] == "api"
    assert lmstudio.registry_body()["hfPath"] == "qwen3.5-4b"
    assert lmstudio.registry_body()["meta"]["backend"] == "openai_compat"


def test_unset_model_file_means_no_models_not_an_error():
    assert load_models_file(None) == []
    assert load_models_file("") == []


@pytest.mark.parametrize(
    "entry, needle",
    [
        ({"modelId": "x", "backend": "openai_compat", "stage": "test"}, "needs basePath"),
        ({"modelId": "x", "backend": "torch_hf", "stage": "base"}, "needs basePath or checkpointDir"),
        ({"modelId": "x", "backend": "torch_hf", "stage": "base", "basePath": "b", "checkpointTag": "t"}, "checkpointTag needs checkpointDir"),
        ({"modelId": "x", "backend": "torch_hf", "stage": "sft", "basePath": "b"}, "no adapterPath/checkpoint"),
        ({"modelId": "x", "backend": "openai_compat", "stage": "test", "basePath": "b", "adapterPath": "a"}, "torch_hf feature"),
        ({"modelId": "x", "backend": "torch_hf", "stage": "base", "checkpointDir": "d"}, "checkpointDir needs checkpointTag"),
        (
            {"modelId": "x", "backend": "torch_hf", "stage": "base", "checkpointDir": "d", "checkpointTag": "t", "adapterPath": "a"},
            "alternatives",
        ),
        ({"modelId": "x", "backend": "torch_hf", "stage": "base", "basePath": "b", "quantization": "int8"}, "quantization"),
        ({"modelId": "x", "backend": "vllm", "stage": "base", "basePath": "b"}, "backend must be"),
        ({"modelId": "x", "backend": "torch_hf", "stage": "eval", "basePath": "b"}, "stage must be"),
    ],
)
def test_a_malformed_model_entry_is_named_precisely(tmp_path: Any, entry: dict, needle: str):
    path = write_models(tmp_path, {"models": [entry]})
    with pytest.raises(ValueError, match=needle):
        load_models_file(path)


def test_a_duplicate_model_id_is_rejected(tmp_path: Any):
    entry = {"modelId": "same", "backend": "openai_compat", "stage": "test", "basePath": "m"}
    with pytest.raises(ValueError, match="duplicate modelId"):
        load_models_file(write_models(tmp_path, {"models": [entry, entry]}))


def test_a_file_without_a_models_array_is_rejected(tmp_path: Any):
    with pytest.raises(ValueError, match="'models' array"):
        load_models_file(write_models(tmp_path, {"model": []}))


# ------------------------------------------------------------------ final answer
def test_a_single_object_final_answer_becomes_a_list():
    assert tolerant_findings({"quadrant": 3, "tooth_position": 6, "diagnosis": "Caries"}) == [
        {"quadrant": 3, "tooth_position": 6, "diagnosis": "Caries"}
    ]


def test_a_full_fdi_code_in_tooth_position_is_kept_not_rewritten():
    # ADR-0014: a model may put 36 in tooth_position; that is a representable mistake and must be scored.
    out = tolerant_findings([{"quadrant": 3, "tooth_position": 36, "diagnosis": "Deep Caries", "confidence": None}])
    assert out == [{"quadrant": 3, "tooth_position": 36, "diagnosis": "Deep Caries", "confidence": None}]


def test_entries_that_are_not_objects_are_dropped_and_none_is_empty():
    assert tolerant_findings(["nope", 3, None, {"quadrant": 1}]) == [{"quadrant": 1}]
    assert tolerant_findings(None) == []


# ------------------------------------------------------------------ openai wire format
def test_images_become_data_uris_and_text_parts_survive():
    msgs = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": [{"type": "image", "image": IMG}, {"type": "text", "text": "hi"}]},
        {"role": "assistant", "content": "{}"},
    ]
    out = to_openai_messages(msgs)
    assert out[0] == {"role": "system", "content": "sys"}
    assert out[1]["content"][0]["type"] == "image_url"
    assert out[1]["content"][0]["image_url"]["url"].startswith("data:image/png;base64,")
    assert out[1]["content"][1] == {"type": "text", "text": "hi"}
    assert out[2] == {"role": "assistant", "content": "{}"}


class _Resp:
    def __init__(self, status: int, body: dict | None = None, text: str = ""):
        self.status_code, self._body, self.text = status, body, text

    @property
    def is_success(self) -> bool:
        return 200 <= self.status_code < 300

    def json(self) -> dict:
        if self._body is None:
            raise ValueError("no json")
        return self._body


class _Http:
    def __init__(self, result: Any):
        self.result = result
        self.calls: list[tuple[str, dict]] = []

    def post(self, url: str, json: dict | None = None, headers: dict | None = None) -> _Resp:
        self.calls.append((url, json or {}))
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


def test_a_reply_is_read_from_the_openai_shape():
    http = _Http(_Resp(200, {"choices": [{"message": {"content": '{"final_answer": []}'}}]}))
    backend = OpenAICompatBackend(base_url="http://x/v1", http=http)
    assert backend.complete([{"role": "user", "content": "hi"}], model="m", temperature=0.2, seed=7) == '{"final_answer": []}'
    url, body = http.calls[0]
    assert url == "http://x/v1/chat/completions"
    assert body["model"] == "m" and body["temperature"] == 0.2 and body["seed"] == 7
    assert body["max_tokens"] == 2048 and body["stream"] is False


def test_a_completer_binds_the_served_model_for_the_loop():
    http = _Http(_Resp(200, {"choices": [{"message": {"content": "{}"}}]}))
    backend = OpenAICompatBackend(base_url="http://x/v1", http=http)
    complete = backend.completer("qwen3.5-4b")
    assert complete([{"role": "user", "content": "hi"}], temperature=0.3, seed=1) == "{}"
    url, body = http.calls[0]
    assert url == "http://x/v1/chat/completions"
    assert body["model"] == "qwen3.5-4b" and body["temperature"] == 0.3 and body["seed"] == 1


def test_content_parts_are_joined():
    http = _Http(_Resp(200, {"choices": [{"message": {"content": [{"text": "a"}, {"text": "b"}]}}]}))
    assert OpenAICompatBackend(http=http).complete([], model="m") == "ab"


def test_an_unreachable_server_is_retryable_and_names_the_url():
    import httpx

    backend = OpenAICompatBackend(base_url="http://localhost:9/v1", http=_Http(httpx.ConnectError("refused")))
    with pytest.raises(ModelUnavailable, match="unreachable"):
        backend.complete([], model="m")
    assert ModelUnavailable("x").retryable is True


def test_a_timeout_is_retryable_and_says_so():
    import httpx

    backend = OpenAICompatBackend(base_url="http://localhost:9/v1", timeout_s=3, http=_Http(httpx.ReadTimeout("slow")))
    with pytest.raises(ModelTimeout, match="did not answer in 3s"):
        backend.complete([], model="m")


def test_a_4xx_is_not_retryable_but_a_5xx_is():
    bad = OpenAICompatBackend(http=_Http(_Resp(400, None, "model not loaded")))
    with pytest.raises(BackendError) as e:
        bad.complete([], model="m")
    assert e.value.retryable is False and "model not loaded" in str(e.value)
    with pytest.raises(ModelUnavailable):
        OpenAICompatBackend(http=_Http(_Resp(503, None, "loading"))).complete([], model="m")


def test_an_unusable_body_is_retryable():
    with pytest.raises(ModelUnavailable, match="unusable body"):
        OpenAICompatBackend(http=_Http(_Resp(200, {"nope": 1}))).complete([], model="m")


# ------------------------------------------------------------------ the loop
def registry() -> ReplayRegistry:
    return ReplayRegistry(
        results={"fdi_label": "36"},
        image_tools={"zoom_crop"},
        names=["fdi_label", "zoom_crop"],
    )


@requires_research
def test_the_loop_sends_the_recorded_protocol_messages():
    backend = ScriptedBackend(['{"tool_calls": [{"tool": "fdi_label", "args": {"quadrant": 3, "tooth_position": 6}}]}',
                               '{"final_answer": [{"quadrant": 3, "tooth_position": 6, "diagnosis": "Caries"}]}'])
    out = backend.run(registry=registry(), image=IMG, max_turns=4)
    assert out.n_tool_calls == 1 and out.format_ok is True
    assert [t["status"] for t in out.turns] == ["tool_executed", "final_answer"]
    second = backend.seen[1]
    assert second[-2] == {"role": "assistant", "content": backend.replies[0]}
    obs = second[-1]["content"]
    assert obs[0] == {"type": "text", "text": 'Result of fdi_label: "36"'}
    # the system prompt is upstream's, with the registered tool descriptions
    assert "fdi_label: replay stub" in backend.seen[0][0]["content"]


@requires_research
def test_an_unparseable_reply_ends_the_run_with_the_last_reply_preserved():
    backend = ScriptedBackend(["not json at all"])
    out = backend.run(registry=registry(), image=IMG)
    assert out.turns[0]["status"] == "unparseable_json"
    assert out.turns[0]["raw_output"] == "not json at all"
    assert out.format_ok is False and out.final_answer is None


@requires_research
def test_an_unknown_tool_is_an_observation_not_a_crash():
    backend = ScriptedBackend(['{"tool_calls": [{"tool": "rm_rf", "args": {}}]}', '{"final_answer": []}'])
    out = backend.run(registry=registry(), image=IMG)
    assert out.turns[0]["status"] == "tool_all_failed"
    assert out.turns[0]["tool_calls_this_turn"][0]["tool_ok"] is False
    assert backend.seen[1][-1]["content"] == [{"type": "text", "text": "Error: Tool 'rm_rf' is not recognized."}]


@requires_research
def test_a_tool_exception_is_recorded_the_way_loop_py_records_it():
    reg = ReplayRegistry(errors={"fdi_label": "boom"}, names=["fdi_label"])
    backend = ScriptedBackend(['{"tool_calls": [{"tool": "fdi_label", "args": {}}]}', '{"final_answer": []}'])
    out = backend.run(registry=reg, image=IMG)
    call = out.turns[0]["tool_calls_this_turn"][0]
    assert call["tool_ok"] is False and call["tool_error"] == "boom"
    assert backend.seen[1][-1]["content"] == [{"type": "text", "text": "Tool 'fdi_label' execution failed: boom"}]


@requires_research
def test_the_budget_is_enforced_and_the_model_is_told():
    reg = ReplayRegistry(results={"fdi_label": "36"}, names=["fdi_label"])
    backend = ScriptedBackend(['{"tool_calls": [{"tool": "fdi_label", "args": {}}]}'] * 3 + ['{"final_answer": []}'])
    out = backend.run(registry=reg, image=IMG, max_tool_calls=1, max_turns=5)
    assert out.n_tool_calls == 1
    assert out.turns[1]["status"] == "budget_exhausted"
    assert backend.seen[2][-1]["content"].startswith("You've used your tool-call budget (1).")


@requires_research
def test_a_tool_image_is_offered_as_an_artifact_and_kept_in_the_observation():
    artifacts: list[tuple[int, int, str, bytes]] = []

    def sink(*a: Any) -> str:
        artifacts.append(a)
        return "00000000-0000-4000-8000-0000000000a1"

    backend = ScriptedBackend(['{"tool_calls": [{"tool": "zoom_crop", "args": {"bbox": [0, 0, 10, 10]}}]}',
                               '{"final_answer": []}'])
    out = backend.run(registry=registry(), image=IMG, on_artifact=sink)
    assert out.turns[0]["status"] == "tool_executed"
    assert len(artifacts) == 1 and artifacts[0][0] == 0 and artifacts[0][2] == "zoom_crop"
    Image.open(io.BytesIO(artifacts[0][3])).verify()
    # the stored id is on the turn, so the app can link the trace to the image (ADR-0025)
    assert out.turns[0]["tool_calls_this_turn"][0]["artifact_id"] == "00000000-0000-4000-8000-0000000000a1"
    parts = backend.seen[1][-1]["content"]
    assert parts[0]["type"] == "image" and parts[1] == {"type": "text", "text": "Result of zoom_crop:"}


@requires_research
def test_cancel_stops_before_the_next_turn_and_keeps_what_was_streamed():
    turns: list[dict] = []
    backend = ScriptedBackend(['{"tool_calls": [{"tool": "fdi_label", "args": {}}]}'] * 5)
    out = backend.run(registry=registry(), image=IMG, on_turn=turns.append, should_stop=lambda: len(turns) >= 1)
    assert len(out.turns) == 1 and len(turns) == 1 and len(backend.seen) == 1


@requires_research
def test_no_tools_mode_is_one_turn_with_upstreams_no_tools_prompt():
    backend = ScriptedBackend(['{"final_answer": [{"quadrant": 1, "tooth_position": 1, "diagnosis": "Caries"}]}'])
    out = backend.run(registry=None, image=IMG, mode="no_tools")
    assert out.n_tool_calls == 0 and out.n_turns == 1 and out.format_ok is True
    assert "diagnostic tools" not in backend.seen[0][0]["content"]
    assert len(backend.seen[0]) == 2


@requires_research
def test_temperature_and_seed_are_forwarded_to_the_server():
    backend = ScriptedBackend(['{"final_answer": []}'])
    backend.run(registry=registry(), image=IMG, temperature=0.7, seed=42)
    assert backend.temperatures == [0.7] and backend.seeds == [42]


# ------------------------------------------------------------------ torch_hf
class Trajectory:
    def __init__(self, turns: list[dict], calls: int, final: Any, ok: bool):
        self.turns, self.tool_calls, self.final_answer, self.format_ok = turns, calls, final, ok


def spec(model_id: str = "m", **kw: Any) -> ModelSpec:
    base: dict[str, Any] = {
        "model_id": model_id,
        "backend": "torch_hf",
        "stage": "base",
        "base_path": "Qwen/Qwen3.5-9B",
    }
    base.update(kw)
    return ModelSpec(**base)


def test_torch_backend_is_lazy_serialized_and_emits_turns_at_completion():
    loads: list[Any] = []
    seen: list[dict] = []
    calls: list[dict] = []
    frames: list[Any] = []

    def loader(s: Any) -> tuple[Any, Any]:
        loads.append(s.model_id)
        return object(), object()

    def frame(image_id: Any, path: Any) -> Any:
        frames.append((image_id, path.exists(), path.read_bytes()[:8]))
        return {"id": image_id, "local_path": str(path)}

    def runner(**kwargs: Any) -> Trajectory:
        calls.append(kwargs)
        return Trajectory([{"turn": 0, "status": "final_answer", "raw_output": "{}", "parsed": {}}], 2, [{"q": 1}], True)

    backend = TorchHFBackend(loader=loader, runner=runner, images_df_factory=frame, registry_factory=lambda: object())
    assert loads == []  # nothing at construction
    out = backend.run(spec(), image=IMG, image_id=7, on_turn=seen.append, max_tool_calls=5, canonical_resize=True)
    assert loads == ["m"]
    assert [t["status"] for t in seen] == ["final_answer"]  # emitted after the run returns
    assert out.n_tool_calls == 2 and out.format_ok is True
    kwargs = calls[0]
    assert kwargs["max_tool_calls"] == 5 and kwargs["canonical_resize"] is True and kwargs["verbose"] is False
    # the image is written to a real PNG that exists while the loop runs
    assert frames == [(7, True, b"\x89PNG\r\n\x1a\n")]
    assert kwargs["images_df"]["id"] == 7 and kwargs["images_df"]["local_path"].endswith(".png")


def test_the_frame_loop_py_reads_is_a_pandas_row_with_id_and_local_path(tmp_path: Any):
    pandas = pytest.importorskip("pandas")
    from backends.torch_hf import _images_df

    path = tmp_path / "1.png"
    IMG.save(path, format="PNG")
    df = _images_df(7, path)
    row = df[df["id"] == 7].iloc[0]  # exactly what dental_agent/agent/loop.py does
    assert row["local_path"] == str(path)
    assert isinstance(df, pandas.DataFrame)


def fake_frame(image_id: Any, path: Any) -> dict[str, Any]:
    """The one-row frame the real runner reads.

    CI installs only pytest+pillow, so the pandas-backed default factory would fail there: every
    torch test that actually runs the loop must inject this (the pandas path has its own test).
    """
    return {"id": image_id, "local_path": str(path)}


def test_torch_backend_no_tools_uses_the_other_upstream_runner():
    def runner(**kwargs: Any) -> Trajectory:
        raise AssertionError("with_tools runner must not be used for the no_tools cohort")

    def no_tools(**kwargs: Any) -> Trajectory:
        return Trajectory([{"turn": 0, "status": None}], 0, [], True)

    backend = TorchHFBackend(loader=lambda s: (object(), object()), runner=runner, no_tools_runner=no_tools,
                             images_df_factory=fake_frame)
    out = backend.run(spec(), image=IMG, image_id=1, mode="no_tools")
    assert out.n_turns == 1 and out.n_tool_calls == 0


def test_an_idle_model_is_released_and_the_next_run_reloads_it():
    now = [0.0]
    loads: list[str] = []

    def loader(s: Any) -> tuple[Any, Any]:
        loads.append(s.model_id)
        return object(), object()

    def runner(**kwargs: Any) -> Trajectory:
        return Trajectory([], 0, None, False)

    backend = TorchHFBackend(loader=loader, runner=runner, idle_unload_s=10, clock=lambda: now[0],
                             images_df_factory=fake_frame, registry_factory=lambda: object())
    backend.run(spec(), image=IMG, image_id=1)
    backend.run(spec(), image=IMG, image_id=1)
    assert loads == ["m"]  # resident
    now[0] = 11.0
    backend.run(spec(), image=IMG, image_id=1)
    assert loads == ["m", "m"]  # unloaded after the idle timeout, then reloaded


def test_switching_model_specs_releases_the_previous_one():
    loads: list[str] = []

    def loader(s: Any) -> tuple[Any, Any]:
        loads.append(s.model_id)
        return object(), object()

    backend = TorchHFBackend(loader=loader, runner=lambda **k: Trajectory([], 0, None, False),
                             images_df_factory=fake_frame, registry_factory=lambda: object())
    backend.run(spec(model_id="a"), image=IMG, image_id=1)
    backend.run(spec(model_id="b"), image=IMG, image_id=1)
    assert loads == ["a", "b"]


def test_a_missing_checkpoint_is_a_retryable_model_unavailable():
    def loader(s: Any) -> tuple[Any, Any]:
        raise FileNotFoundError("no such dir")

    backend = TorchHFBackend(loader=loader)
    with pytest.raises(ModelUnavailable, match="weights not found"):
        backend.ensure_loaded(spec())


def test_a_broken_install_is_retryable_and_names_the_error():
    def loader(s: Any) -> tuple[Any, Any]:
        raise OSError("cuda oom")

    with pytest.raises(ModelUnavailable, match="cuda oom"):
        TorchHFBackend(loader=loader).ensure_loaded(spec())


def test_a_merged_checkpoint_uses_upstreams_checkpoint_loader():
    seen: list[Any] = []

    def checkpoint_loader(s: Any) -> tuple[Any, Any]:
        seen.append((s.checkpoint_dir, s.checkpoint_tag))
        return object(), object()

    backend = TorchHFBackend(checkpoint_loader=checkpoint_loader)
    backend.ensure_loaded(spec(base_path=None, checkpoint_dir="C:/ckpt", checkpoint_tag="grpo-1"))
    assert seen == [("C:/ckpt", "grpo-1")]


def test_an_adapter_directory_without_config_is_refused_before_peft_is_called(tmp_path: Any):
    from backends.torch_hf import _apply_adapter

    with pytest.raises(BackendError, match="adapter_config.json"):
        _apply_adapter(object(), str(tmp_path))


def test_a_worker_stop_before_a_torch_run_does_not_load_a_model():
    loads: list[str] = []
    backend = TorchHFBackend(loader=lambda s: loads.append(s.model_id) or (object(), object()))
    out = backend.run(spec(), image=IMG, image_id=1, should_stop=lambda: True)
    assert loads == [] and out.n_turns == 0
