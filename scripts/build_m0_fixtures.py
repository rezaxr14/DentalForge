"""
M0 fixture builder — sanitizes REAL VLM-DENTAL lines into committed fixtures.

Reads from the read-only VLM-DENTAL checkout, writes sanitized JSON into
DentalForge/fixtures/. Sanitization:
- image_path: machine-specific local path -> basename placeholder
- messages: full chat transcript (the teacher scaffold in stored user
  messages + system prompt) -> replaced with a structural summary {n_messages, roles[]}.
  Fixtures keep turns[] (the replayable agent behavior) verbatim, truncated
  to the first few turns for size.
- eval raw_output: free text kept only in truncated form (first 500 chars).

Usage: python scripts/build_m0_fixtures.py
"""
import json
import os
import sys

VLM = r"c:/Users/rezax/Home/Code/VLM-DENTAL"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fixtures")

TRACE_FILES = {
    "verified_with_tools": "data/traces/train_cot_traces.jsonl",
    "verified_no_tools": "data/traces/train_cot_traces_no_tools.jsonl",
    "verified_healthy": "data/traces/train_cot_traces_healthy_dentex.jsonl",
    "verified_tufts_all": "data/traces/train_cot_traces_tufts_all.jsonl",
    "unverified_dentex": "data/traces/train_cot_traces_unverified_dentex.jsonl",
}

EVAL_FILES = {
    "kimi_k3": "data/evaluations/zero_shot_dentex_test_nvidia_nim_moonshotai--kimi-k3.jsonl",
    "gemini_flash": "data/evaluations/zero_shot_dentex_test_gemini_gemini-3.5-flash.jsonl",
    "qwen": "data/evaluations/zero_shot_dentex_test_transformers_Qwen--Qwen3.5-9B.jsonl",
    "llama11b": "data/evaluations/zero_shot_dentex_test_nvidia_nim_meta--llama-3.2-11b-vision-instruct.jsonl",
}


def sanitize_trace(line: dict, max_turns: int = 4) -> dict:
    d = dict(line)
    d["image_path"] = "<SANITIZED>/" + str(d.get("image_path", "")).split("/")[-1]
    # Keep messages as a real ARRAY (schema requires it) but scrub content:
    # system prompt + TEACHER DIRECTIVE leaks are replaced with a placeholder.
    scrubbed = []
    for m in d.get("messages", []):
        if isinstance(m, dict):
            content = m.get("content")
            if isinstance(content, list):
                content = [
                    {"type": b.get("type", "text"), "text": "<SANITIZED>"}
                    if isinstance(b, dict)
                    else "<SANITIZED>"
                    for b in content
                ]
            elif isinstance(content, str):
                content = "<SANITIZED>"
            scrubbed.append({"role": m.get("role"), "content": content})
        else:
            scrubbed.append("<SANITIZED>")
    d["messages"] = scrubbed[:6]
    d["turns"] = d.get("turns", [])[:max_turns]
    if isinstance(d.get("verifier_reason"), str):
        d["verifier_reason"] = d["verifier_reason"][:500]
    return d


def sanitize_unverified(line: dict) -> dict:
    d = dict(line)
    d["image_path"] = "<SANITIZED>/" + str(d.get("image_path", "")).split("/")[-1]
    traj = d.get("trajectory")
    if isinstance(traj, dict):
        turns = traj.get("turns", [])
        msgs = traj.get("messages", [])
        d["trajectory"] = {
            "sanitized": True,
            "n_turns": len(turns),
            "n_messages": len(msgs),
            "turns": turns[:2],
        }
    return d


def sanitize_eval(line: dict) -> dict:
    d = dict(line)
    if isinstance(d.get("raw_output"), str):
        d["raw_output"] = d["raw_output"][:500]
    return d


def main() -> None:
    os.makedirs(os.path.join(OUT, "traces"), exist_ok=True)
    os.makedirs(os.path.join(OUT, "evals"), exist_ok=True)
    manifest: dict = {"traces": {}, "evals": {}}

    for name, rel in TRACE_FILES.items():
        src = os.path.join(VLM, rel)
        with open(src, encoding="utf-8") as f:
            first = json.loads(f.readline())
        if name.startswith("unverified"):
            clean = sanitize_unverified(first)
        else:
            clean = sanitize_trace(first)
        dest = os.path.join(OUT, "traces", f"{name}.json")
        with open(dest, "w", encoding="utf-8") as f:
            json.dump(clean, f, indent=2)
        manifest["traces"][name] = {"source": rel, "sanitized": True}
        print(f"wrote {dest} ({os.path.getsize(dest)} bytes)")

    for name, rel in EVAL_FILES.items():
        src = os.path.join(VLM, rel)
        with open(src, encoding="utf-8") as f:
            first = json.loads(f.readline())
        clean = sanitize_eval(first)
        dest = os.path.join(OUT, "evals", f"{name}.json")
        with open(dest, "w", encoding="utf-8") as f:
            json.dump(clean, f, indent=2)
        manifest["evals"][name] = {"source": rel, "sanitized": True}
        print(f"wrote {dest} ({os.path.getsize(dest)} bytes)")

    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print("wrote fixtures/manifest.json")


if __name__ == "__main__":
    sys.exit(main())
