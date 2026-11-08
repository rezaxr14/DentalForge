"""The OpenAI-compatible backend (TEST backend) and the loop it shares with ``mock``.

The loop is a faithful copy of the protocol in VLM-DENTAL's ``dental_agent/agent/loop.py``:
same system prompt builder, same first user prompt, same ``Result of <tool>:`` observations,
same malformed-JSON retry text, same budget message, same "assistant reply then user observation"
message order. Only the token generation is replaced by an HTTP call (or, for ``mock``, by a
scripted list of replies). That is deliberate: SFT/GRPO trained on those exact messages, so a
re-implementation from memory would silently change what the model sees.

`agent.run` streams one ``turn`` event per turn here, because this loop owns each reply.
"""
from __future__ import annotations

import base64
import io
import json
import os
from typing import Any, Callable

from .base import ArtifactSink, BackendError, ModelTimeout, ModelUnavailable, RunOutcome, TurnSink

from PIL import Image

#: (messages) -> raw assistant reply. `messages` uses VLM-DENTAL's own shape (PIL images inside).
Complete = Callable[[list[dict[str, Any]]], str]

MAX_NEW_TOKENS = 2048


def _png_bytes(image: Any) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def to_openai_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert VLM-DENTAL's message list (PIL images inline) to the OpenAI chat wire format."""
    out: list[dict[str, Any]] = []
    for m in messages:
        content = m.get("content")
        if isinstance(content, str):
            out.append({"role": m["role"], "content": content})
            continue
        parts: list[dict[str, Any]] = []
        for part in content or []:
            if part.get("type") == "image":
                b64 = base64.b64encode(_png_bytes(part["image"])).decode("ascii")
                parts.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}})
            elif part.get("type") == "text":
                parts.append({"type": "text", "text": part["text"]})
            else:  # pragma: no cover - upstream only emits image/text parts
                raise BackendError(f"unsupported message part type {part.get('type')!r}")
        out.append({"role": m["role"], "content": parts})
    return out


class OpenAICompatBackend:
    """LM Studio / any OpenAI-compatible server. Test backend: never the research model."""

    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        timeout_s: float | None = None,
        http: Any = None,
    ):
        self.base_url = (base_url or os.environ.get("WORKER_OPENAI_BASE_URL") or "http://localhost:1234/v1").rstrip("/")
        self.api_key = api_key if api_key is not None else os.environ.get("WORKER_OPENAI_API_KEY", "")
        self.timeout_s = float(timeout_s if timeout_s is not None else os.environ.get("WORKER_OPENAI_TIMEOUT_S", "300"))
        self._http = http

    def _client(self) -> Any:
        if self._http is None:
            import httpx

            self._http = httpx.Client(timeout=self.timeout_s)
        return self._http

    def complete(self, messages: list[dict[str, Any]], *, model: str, temperature: float = 0.0, seed: int | None = None) -> str:
        """One assistant reply from the server. Raises `ModelUnavailable`/`ModelTimeout`."""
        import httpx

        body: dict[str, Any] = {
            "model": model,
            "messages": to_openai_messages(messages),
            "max_tokens": MAX_NEW_TOKENS,
            "temperature": temperature,
            "stream": False,
        }
        if seed is not None:
            body["seed"] = seed
        headers = {"content-type": "application/json"}
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        try:
            r = self._client().post(f"{self.base_url}/chat/completions", json=body, headers=headers)
        except httpx.TimeoutException as e:
            raise ModelTimeout(f"model server at {self.base_url} did not answer in {self.timeout_s:.0f}s") from e
        except httpx.HTTPError as e:
            raise ModelUnavailable(f"model server at {self.base_url} is unreachable: {type(e).__name__}: {e}") from e
        if not r.is_success:
            detail = r.text[:400]
            if r.status_code >= 500 or r.status_code == 429:
                raise ModelUnavailable(f"model server returned {r.status_code}: {detail}")
            raise BackendError(f"model server rejected the request ({r.status_code}): {detail}")
        try:
            payload = r.json()
            message = payload["choices"][0]["message"]
            content = message.get("content")
        except (ValueError, KeyError, IndexError, TypeError) as e:
            raise ModelUnavailable(f"model server returned an unusable body: {e}") from e
        if isinstance(content, list):  # some servers return content parts
            content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
        if not isinstance(content, str):
            raise ModelUnavailable("model server returned no text content")
        return content

    def completer(self, model: str) -> Callable[..., str]:
        """Bind the served model name, which is what `run_loop` calls: `complete(messages, temperature=...)`.

        `complete` deliberately requires `model` (a backend may serve several entries), but the loop
        is model-agnostic. Without this binding the handler passes `complete` itself and every run
        dies on the missing keyword argument — the failure the live e2e found.
        """
        def complete(messages: list[dict[str, Any]], *, temperature: float = 0.0, seed: int | None = None) -> str:
            return self.complete(messages, model=model, temperature=temperature, seed=seed)

        return complete


def run_loop(
    complete: Callable[..., str],
    *,
    registry: Any,
    image: Any,
    mode: str = "with_tools",
    max_turns: int | None = None,
    max_tool_calls: int = 50,
    canonical_resize: bool = False,
    temperature: float = 0.0,
    seed: int | None = None,
    dataset: str = "dentex",
    on_turn: TurnSink | None = None,
    on_artifact: ArtifactSink | None = None,
    should_stop: Callable[[], bool] | None = None,
) -> RunOutcome:
    """Run the protocol above against `complete`. See the module docstring for why it is a copy."""
    from dental_agent.agent.parsing import parse_agent_json
    from dental_agent.agent.prompts import FIRST_USER_PROMPT, NO_TOOLS_SYSTEM_PROMPT, build_agent_system_prompt
    from dental_agent.agent.tool_dispatch import execute_tool_call
    from dental_agent.utils.canonical import family_for_tool, to_canonical
    from dental_agent.utils.serialization import to_jsonable

    def emit(turn: dict[str, Any]) -> None:
        if on_turn is not None:
            on_turn(turn)

    if mode == "no_tools":
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": NO_TOOLS_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": image},
                    {"type": "text", "text": FIRST_USER_PROMPT},
                ],
            },
        ]
        reply = complete(messages, temperature=temperature, seed=seed)
        parsed = parse_agent_json(reply)
        turn = {"turn": 0, "raw_output": reply, "parsed": parsed}
        emit(turn)
        answer = (parsed or {}).get("final_answer")
        return RunOutcome(
            turns=[turn],
            n_tool_calls=0,
            final_answer=answer,
            format_ok=isinstance(answer, (dict, list)),
            messages=messages,
        )

    registered = registry.list_tools()
    registered_names = {t.name for t in registered}
    system_prompt = build_agent_system_prompt(registry.format_tool_descriptions(), dataset=dataset)
    messages = [
        {"role": "system", "content": system_prompt},
        {
            "role": "user",
            "content": [
                {"type": "image", "image": image},
                {"type": "text", "text": FIRST_USER_PROMPT},
            ],
        },
    ]

    turns: list[dict[str, Any]] = []
    final_answer = None
    tool_call_count = 0
    # Upstream: 0 retries by default in `run_agent`, and `max_turns` defaults to max_tool_calls+15.
    malformed_retries = 0
    malformed_used = 0
    limit = max_turns if max_turns is not None else max_tool_calls + 15

    for turn_idx in range(limit):
        if should_stop is not None and should_stop():
            break
        reply = complete(messages, temperature=temperature, seed=seed)
        parsed = parse_agent_json(reply)
        turn_record: dict[str, Any] = {"turn": turn_idx, "raw_output": reply, "parsed": parsed}

        if not parsed:
            turn_record["status"] = "unparseable_json"
            turns.append(turn_record)
            emit(turn_record)
            messages.append({"role": "assistant", "content": reply})
            if malformed_used < malformed_retries:
                malformed_used += 1
                messages.append(
                    {
                        "role": "user",
                        "content": "Error: your response was not a single valid JSON object. "
                        "Respond with exactly one JSON object.",
                    }
                )
                continue
            break

        if "final_answer" in parsed:
            final_answer = parsed["final_answer"]
            turn_record["status"] = "final_answer"
            turns.append(turn_record)
            emit(turn_record)
            messages.append({"role": "assistant", "content": reply})
            break

        tool_calls = parsed.get("tool_calls")
        if not tool_calls or not isinstance(tool_calls, list):
            turn_record["status"] = "invalid_tool"
            turn_record["tool_calls_this_turn"] = []
            turns.append(turn_record)
            emit(turn_record)
            messages.append({"role": "assistant", "content": reply})
            messages.append(
                {"role": "user", "content": "Error: no valid tool_calls or final_answer found in your response."}
            )
            continue

        if tool_call_count >= max_tool_calls:
            turn_record["status"] = "budget_exhausted"
            turn_record["tool_calls_this_turn"] = []
            turns.append(turn_record)
            emit(turn_record)
            messages.append({"role": "assistant", "content": reply})
            messages.append(
                {
                    "role": "user",
                    "content": f"You've used your tool-call budget ({max_tool_calls}). "
                    f"Provide your final_answer now based on what you've already seen.",
                }
            )
            continue

        observation_content: list[dict[str, Any]] = []
        calls_this_turn: list[dict[str, Any]] = []
        any_ok = False

        for call_idx, call in enumerate(tool_calls):
            if tool_call_count >= max_tool_calls:
                break
            tool_name = call.get("tool") if isinstance(call, dict) else None
            tool_args = call.get("args", {}) if isinstance(call, dict) else {}
            call_record: dict[str, Any] = {"tool_name": tool_name, "tool_args": tool_args}

            if not tool_name or tool_name not in registered_names:
                call_record["tool_ok"] = False
                call_record["tool_error"] = f"Tool '{tool_name}' is not recognized."
                observation_content.append(
                    {"type": "text", "text": f"Error: Tool '{tool_name}' is not recognized."}
                )
                calls_this_turn.append(call_record)
                continue

            tool_call_count += 1
            try:
                tool_out = execute_tool_call(registry, tool_name, tool_args, image)
                if isinstance(tool_out, Image.Image):
                    if canonical_resize:
                        tool_out = to_canonical(tool_out, family_for_tool(tool_name))
                    observation_content.append({"type": "image", "image": tool_out})
                    observation_content.append({"type": "text", "text": f"Result of {tool_name}:"})
                    if on_artifact is not None:
                        artifact_id = on_artifact(turn_idx, call_idx, tool_name, _png_bytes(tool_out))
                        if artifact_id:
                            call_record["artifact_id"] = artifact_id
                else:
                    observation_content.append(
                        {
                            "type": "text",
                            "text": f"Result of {tool_name}: {json.dumps(to_jsonable(tool_out))}",
                        }
                    )
                call_record["tool_ok"] = True
                any_ok = True
            except Exception as e:  # noqa: BLE001 - loop.py records tool failures the same way
                call_record["tool_ok"] = False
                call_record["tool_error"] = str(e)
                observation_content.append({"type": "text", "text": f"Tool '{tool_name}' execution failed: {e}"})
            calls_this_turn.append(call_record)

        turn_record["tool_calls_this_turn"] = calls_this_turn
        turn_record["status"] = "tool_executed" if any_ok else "tool_all_failed"
        turns.append(turn_record)
        emit(turn_record)
        messages.append({"role": "assistant", "content": reply})
        messages.append({"role": "user", "content": observation_content})

    return RunOutcome(
        turns=turns,
        n_tool_calls=tool_call_count,
        final_answer=final_answer,
        format_ok=isinstance(final_answer, (dict, list)),
        messages=messages,
    )
