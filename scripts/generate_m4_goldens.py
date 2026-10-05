"""
M4 golden-file generator — runs REAL VLM-DENTAL tool functions on tiny
synthetic pixel vectors and snapshots outputs for TS parity tests.
"""
import json
import os
import sys

VLM = r"c:/Users/rezax/Home/Code/VLM-DENTAL"
sys.path.insert(0, VLM)

import numpy as np

from PIL import Image, ImageEnhance
from dental_agent.tools.windowing import tool_window_level, WINDOW_PRESETS
from dental_agent.tools.zoom_crop import tool_zoom_crop, box_out_of_bounds
from dental_agent.tools.nudge import tool_nudge_crop
from dental_agent.tools.denoise import tool_denoise
from dental_agent.tools.contralateral import tool_contralateral_compare
from dental_agent.tools.fdi import (
    fdi_encode, fdi_decode, tool_fdi_label, get_anatomical_name, flip_quadrant,
)

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fixtures", "goldens")
os.makedirs(OUT, exist_ok=True)
goldens: dict = {}

# 1. contrast: PIL degenerate-image math on a known row
row = [0, 64, 192, 255]
img = Image.new("L", (4, 1))
img.putdata(row)
goldens["contrast_gray"] = {
    "in": row, "factor": 1.5,
    "out": list(ImageEnhance.Contrast(img.convert("RGB")).enhance(1.5).convert("L").getdata()),
}
rgb = [(200, 100, 50), (0, 0, 0), (255, 255, 255)]
img2 = Image.new("RGB", (3, 1))
img2.putdata(rgb)
goldens["contrast_rgb"] = {
    "in": rgb, "factor": 1.5,
    "out": [list(p) for p in ImageEnhance.Contrast(img2).enhance(1.5).getdata()],
}
# rounding-tie probe: mean([2,66,190,254])=128, factor 1.25 -> value 66 maps to exactly 50.5
img_tie = Image.new("L", (4, 1))
img_tie.putdata([2, 66, 190, 254])
goldens["contrast_tie"] = {
    "in": [2, 66, 190, 254], "factor": 1.25,
    "out": list(ImageEnhance.Contrast(img_tie.convert("RGB")).enhance(1.25).convert("L").getdata()),
}

# 2. windowing presets + custom
img3 = Image.new("RGB", (4, 1))
img3.putdata([(0, 0, 0), (100, 100, 100), (150, 150, 150), (255, 255, 255)])
goldens["window_presets"] = {k: v for k, v in WINDOW_PRESETS.items()}
goldens["window_out"] = {}
for preset in ["bone", "enamel", "soft_tissue", "metal_reduction"]:
    goldens["window_out"][preset] = list(tool_window_level(img3, preset).convert("L").getdata())
goldens["window_out"]["custom_c100_w50"] = list(tool_window_level(img3, "bone", center=100, width=50).convert("L").getdata())
goldens["window_out"]["bad_preset_falls_back_to_bone"] = list(
    tool_window_level(img3, "nope").convert("L").getdata()
)

# 3. zoom_crop geometry on a 100x80 image
goldens["zoom_crop"] = {
    "basic": list(tool_zoom_crop(Image.new("RGB", (100, 80)), [10, 10, 20, 20]).size),
    "clamped": list(tool_zoom_crop(Image.new("RGB", (100, 80)), [90, 70, 30, 30]).size),
    "min_pad_50": list(tool_zoom_crop(Image.new("RGB", (100, 80)), [40, 40, 4, 4]).size),
    "oob_true": box_out_of_bounds([90, 70, 30, 30], 100, 80),
    "oob_false": box_out_of_bounds([10, 10, 20, 20], 100, 80),
}

# 4. nudge geometry (image only used for clamping)
big = Image.new("RGB", (1000, 800))
goldens["nudge"] = {
    "shift": tool_nudge_crop(big, [100, 100, 200, 100], dx_frac=0.5, dy_frac=-0.5, scale=1.0),
    "scale_up": tool_nudge_crop(big, [100, 100, 200, 100], scale=2.0),
    "bad": tool_nudge_crop(big, [1, 2, 3], scale=1.0),
}

# 5. fdi helpers
goldens["fdi"] = {
    "encode_48": fdi_encode(4, 8),
    "decode_48": list(fdi_decode(48)),
    "label_36": tool_fdi_label(3, 6),
    "label_bad": tool_fdi_label(5, 9),
    "anatomy_11": get_anatomical_name(11),
    "flip_1": flip_quadrant(1),
    "flip_3": flip_quadrant(3),
}

# 6. denoise on a tiny synthetic RGB image (median exact; bilateral tolerance-tested)
rng = np.random.default_rng(7)
tiny = rng.integers(0, 256, (8, 8, 3), dtype=np.uint8)
img4 = Image.fromarray(tiny, "RGB")
goldens["denoise_in"] = [[int(v) for v in row] for row in tiny.reshape(-1, 3).tolist()]
goldens["denoise_median_0_6"] = [
    [int(v) for v in row]
    for row in np.array(tool_denoise(img4, method="median", strength=0.6)).reshape(-1, 3).tolist()
]
goldens["denoise_bilateral_0_6"] = [
    [int(v) for v in row]
    for row in np.array(tool_denoise(img4, method="bilateral", strength=0.6)).reshape(-1, 3).tolist()
]

# 7. contralateral composite geometry on a 40x20 image with distinct probes
img5 = Image.new("RGB", (40, 20), color=(10, 10, 10))
px = img5.load()
px[5, 5] = (200, 30, 30)       # inside target crop (4,4,6,6)
px[31, 5] = (30, 200, 30)      # inside the mirror crop (x 30..36, y 4..10)
comp = tool_contralateral_compare(img5, [4, 4, 6, 6], quadrant=1)
cpx = comp.load()
goldens["contralateral"] = {
    "size": list(comp.size),
    "target_pixel": list(cpx[1, 1]),
    "mirror_pixel": list(cpx[17, 1]),
    "divider_pixel": list(cpx[6, 1]),
    "oob_fallback_size": list(tool_contralateral_compare(img5, [100, 100, 5, 5], 1).size),
}

with open(os.path.join(OUT, "m4_tools.json"), "w", encoding="utf-8") as f:
    json.dump(goldens, f, indent=2)
print("wrote fixtures/goldens/m4_tools.json")
