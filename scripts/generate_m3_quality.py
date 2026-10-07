"""
M3 quality-stats generator — scans REAL VLM-DENTAL trace files (read-only)
and snapshots aggregate quality signals as JSON for the Data-Quality
dashboard + TS parity tests.

Leak definition (R1 / plan section 11.5): reuses VLM-DENTAL
`scripts/patch_and_regenerate_traces.py::check_for_leaks` — assistant-role
messages only, first matching LEAK_PATTERN per message — plus an assistant
`parsed.thought` scan with the same patterns. The `TEACHER DIRECTIVE`
string in stored *user* messages is the generation scaffold, reported
separately as `teacher_scaffold` (expected, not a leak).
"""
import collections
import glob
import json
import os
import sys

VLM = r"c:/Users/rezax/Home/Code/VLM-DENTAL"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fixtures", "goldens")

sys.path.insert(0, VLM)
from scripts.patch_and_regenerate_traces import LEAK_PATTERNS, check_for_leaks

KNOWN_TOOLS = {
    "zoom_crop", "window_level", "locate_tooth", "fdi_label",
    "denoise", "contralateral_compare", "enhance_contrast", "nudge_crop",
}


def msg_role(m):
    return m.get("role") if isinstance(m, dict) else None


def msg_text(m):
    if not isinstance(m, dict):
        return ""
    c = m.get("content", "")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        parts = []
        for b in c:
            if isinstance(b, dict) and b.get("type") == "text":
                parts.append(str(b.get("text", "")))
            elif isinstance(b, dict) and "text" in b:
                parts.append(str(b["text"]))
        return "\n".join(parts)
    return str(c)


def thought_leaks(turns):
    """Assistant parsed.thought scan with the same LEAK_PATTERNS."""
    hits = []
    for t in turns or []:
        p = t.get("parsed")
        thought = p.get("thought") if isinstance(p, dict) else None
        if not isinstance(thought, str):
            continue
        for pat in LEAK_PATTERNS:
            m = pat.search(thought)
            if m:
                hits.append(f"turn {t.get('turn')}: '{m.group(0)}'")
                break
    return hits

files = sorted(glob.glob(os.path.join(VLM, "data", "traces", "train_cot_traces*.jsonl")))
files = [f for f in files if "unverified" not in f]

per_file: dict = {}
overall_tools: collections.Counter = collections.Counter()
overall_status: collections.Counter = collections.Counter()
overall_bad_tools: collections.Counter = collections.Counter()
pert: collections.Counter = collections.Counter()
n_total = 0

for path in files:
    name = os.path.basename(path)
    n = 0
    leak = 0
    scaffold = 0
    leak_details: dict = {}
    statuses: collections.Counter = collections.Counter()
    tools: collections.Counter = collections.Counter()
    bad: collections.Counter = collections.Counter()
    healthy_fp = 0
    for line in open(path, encoding="utf-8"):
        d = json.loads(line)
        n += 1
        # Real definition: assistant messages only (check_for_leaks).
        has_leak, details = check_for_leaks(d)
        th = thought_leaks(d.get("turns", []))
        if has_leak or th:
            leak += 1
            leak_details[str(d.get("image_id"))] = details + th
        # Generation scaffold (expected): marker in stored non-assistant text.
        if any(
            "TEACHER DIRECTIVE" in msg_text(m)
            for m in d.get("messages", [])
            if isinstance(m, dict) and msg_role(m) != "assistant"
        ):
            scaffold += 1
        for t in d.get("turns", []):
            statuses[t.get("status", "<none>")] += 1
            for c in t.get("tool_calls_this_turn", []) or []:
                tools[c.get("tool_name")] += 1
                if c.get("tool_name") not in KNOWN_TOOLS:
                    bad[c.get("tool_name")] += 1
                if c.get("perturb_tier"):
                    pert[c.get("perturb_tier")] += 1
        if not d.get("ground_truth") and d.get("final_answer"):
            healthy_fp += 1
    per_file[name] = {
        "n": n, "directive_leak": leak, "teacher_scaffold": scaffold,
        "leak_details": leak_details,
        "statuses": dict(statuses), "tools": dict(tools),
        "unknown_tools": dict(bad), "healthy_false_positives": healthy_fp,
    }
    n_total += n
    overall_tools.update(tools)
    overall_status.update(statuses)
    overall_bad_tools.update(bad)

stats = {
    "n_files": len(files),
    "n_traces": n_total,
    "overall_tools": dict(overall_tools),
    "overall_statuses": dict(overall_status),
    "overall_unknown_tools": dict(overall_bad_tools),
    "perturb_tiers": dict(pert),
    "per_file": per_file,
}

with open(os.path.join(OUT, "m3_quality.json"), "w", encoding="utf-8") as f:
    json.dump(stats, f, indent=2)
print(f"wrote m3_quality.json: {n_total} traces across {len(files)} files")
