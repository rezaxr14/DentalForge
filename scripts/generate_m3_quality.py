"""
M3 quality-stats generator — scans REAL VLM-DENTAL trace files (read-only)
and snapshots aggregate quality signals as JSON for the Data-Quality
dashboard + TS parity tests.

Run: ../VLM-DENTAL/.venv/Scripts/python.exe scripts/generate_m3_quality.py
"""
import collections
import glob
import json
import os

VLM = r"c:/Users/rezax/Home/Code/VLM-DENTAL"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fixtures", "goldens")

KNOWN_TOOLS = {
    "zoom_crop", "window_level", "locate_tooth", "fdi_label",
    "denoise", "contralateral_compare", "enhance_contrast", "nudge_crop",
}

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
    statuses: collections.Counter = collections.Counter()
    tools: collections.Counter = collections.Counter()
    bad: collections.Counter = collections.Counter()
    healthy_fp = 0
    for line in open(path, encoding="utf-8"):
        d = json.loads(line)
        n += 1
        if any(
            "TEACHER DIRECTIVE" in str(m.get("content"))
            for m in d.get("messages", [])
            if isinstance(m, dict)
        ):
            leak += 1
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
        "n": n, "directive_leak": leak,
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
