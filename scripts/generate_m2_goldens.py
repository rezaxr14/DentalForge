"""
M2 golden-file generator — runs the REAL VLM-DENTAL Python functions
(read-only) and snapshots their outputs as JSON for TS parity tests.

Run from DentalForge with the VLM-DENTAL venv:
  ../VLM-DENTAL/.venv/Scripts/python.exe scripts/generate_m2_goldens.py
"""
import json
import os
import sys

VLM = r"c:/Users/rezax/Home/Code/VLM-DENTAL"
sys.path.insert(0, VLM)
os.chdir(VLM)

from dental_agent.evaluation.metrics import (
    normalize_dental_diagnosis,
    compute_finding_closeness,
    match_multi_findings,
    expected_calibration_error,
    bootstrap_metric_ci,
    bootstrap_paired_diff_ci,
)
from dental_agent.rewards.components import (
    reward_accuracy,
    reward_format,
    reward_tool_validity,
    reward_efficiency,
)
from dental_agent.rewards.composite import combine_reward

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fixtures", "goldens")
os.makedirs(OUT, exist_ok=True)

goldens: dict = {}

# 1. normalize_dental_diagnosis — cover the variants seen in real data
diag_inputs = [
    "Impacted", "Impacted Tooth", "impacted tooth", "IMPACTED",
    "Caries", "caries lesion", "carious lesion", "Deep Caries", "deep carious",
    "Periapical Lesion", "periapical", "abscess", "Non-Odontogenic Lesion",
    "Pericoronal Lesion", "Inter-Radicular Lesion", "unerupted", None, "",
]
goldens["normalize_diagnosis"] = {str(v): normalize_dental_diagnosis(v) for v in diag_inputs}

# 2. compute_finding_closeness — representative pairs
gt = {"quadrant": 4, "tooth_position": 8, "diagnosis": "Impacted"}
pairs = [
    {"quadrant": 4, "tooth_position": 8, "diagnosis": "Impacted Tooth"},  # exact (normalized)
    {"quadrant": 4, "tooth_position": 7, "diagnosis": "Caries"},          # adjacent, diff diag
    {"quadrant": 3, "tooth_position": 8, "diagnosis": "Impacted"},        # arch symmetry
    {"quadrant": 1, "tooth_position": 1, "diagnosis": "Caries"},          # far
    {"quadrant": 4, "tooth_position": 8, "diagnosis": "Deep Caries"},     # same tooth, progression?
    {"quadrant": 2, "tooth_position": 6, "diagnosis": "Periapical Lesion"},
]
goldens["closeness"] = [
    {"pred": p, "out": list(compute_finding_closeness(gt, p))} for p in pairs
]

# 3. match_multi_findings — multi-finding case with a hallucination + a miss
gts = [
    {"quadrant": 4, "tooth_position": 8, "diagnosis": "Impacted"},
    {"quadrant": 4, "tooth_position": 7, "diagnosis": "Caries"},
    {"quadrant": 3, "tooth_position": 8, "diagnosis": "Impacted"},
]
preds = [
    {"quadrant": 4, "tooth_position": 8, "diagnosis": "Impacted Tooth", "confidence": 0.95},
    {"quadrant": 4, "tooth_position": 7, "diagnosis": "Deep Caries", "confidence": 0.85},
    {"quadrant": 1, "tooth_position": 1, "diagnosis": "Caries", "confidence": 0.5},
]
goldens["match_multi"] = match_multi_findings(gts, preds)

# 4. ECE
goldens["ece"] = {
    "perfect": expected_calibration_error([0.9, 0.9, 0.1, 0.1], [1, 1, 0, 0]),
    "overconfident": expected_calibration_error([0.9, 0.9, 0.9, 0.9], [1, 0, 0, 0]),
    "empty": expected_calibration_error([], []),
}

# 5. bootstrap CIs (fixed seeds -> deterministic)
goldens["bootstrap_ci"] = list(
    bootstrap_metric_ci([0.2, 0.4, 0.6, 0.8, 1.0], lambda xs: sum(xs) / len(xs))
)
pm, (plo, phi) = bootstrap_paired_diff_ci([0.5, 0.6, 0.7], [0.4, 0.5, 0.6])
goldens["bootstrap_paired"] = {"mean": pm, "lo": plo, "hi": phi}

# 6. Rewards on a real fixture-like trajectory (built from sanitized shapes)
traj_with_tools = {
    "format_ok": True,
    "final_answer": [
        {"quadrant": 4, "tooth_position": 8, "diagnosis": "Impacted Tooth", "confidence": 0.95},
        {"quadrant": 4, "tooth_position": 7, "diagnosis": "Caries", "confidence": 0.85},
    ],
    "turns": [
        {"turn": 0, "status": "tool_executed", "tool_calls_this_turn": [
            {"tool_name": "locate_tooth", "tool_args": {"tooth": 48}, "tool_ok": True},
            {"tool_name": "locate_tooth", "tool_args": {"tooth": 47}, "tool_ok": True},
            {"tool_name": "zoom_crop", "tool_args": {"bbox": [1, 2, 3, 4]}, "tool_ok": True},
        ]},
        {"turn": 1, "status": "final_answer", "raw_output": "{}",
         "parsed": {"thought": "done", "final_answer": []}},
    ],
}
traj_no_tools = {
    "format_ok": True,
    "final_answer": [{"quadrant": 4, "tooth_position": 8, "diagnosis": "Impacted"}],
    "turns": [{"turn": 1, "raw_output": "{}",
               "parsed": {"thought": "x", "final_answer": [{"quadrant": 4, "tooth_position": 8, "diagnosis": "Impacted"}]}}],
    "tool_calls": [],
}
traj_empty = {"format_ok": False, "final_answer": [], "turns": [], "tool_calls": []}
reward_gt = [
    {"quadrant": 4, "tooth_position": 8, "diagnosis": "Impacted"},
    {"quadrant": 4, "tooth_position": 7, "diagnosis": "Caries"},
]
goldens["rewards"] = {}
for name, tj in [("with_tools", traj_with_tools), ("no_tools", traj_no_tools), ("empty", traj_empty)]:
    total, comp = combine_reward(tj, reward_gt)
    goldens["rewards"][name] = {"total": total, "components": comp}

with open(os.path.join(OUT, "m2_goldens.json"), "w", encoding="utf-8") as f:
    json.dump(goldens, f, indent=2)
print("wrote fixtures/goldens/m2_goldens.json")
