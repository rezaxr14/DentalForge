"""
M5 LabelForge fixture generator — reads REAL DENTEX COCO annotations, runs
REAL YOLO CV inference for replay-tier pre-labels, and cross-checks GT against
the committed trace fixtures before writing anything.

Outputs:
  fixtures/labels/<id>.json   (LabelFixture contract: src/shared/contracts/labels.ts)
  public/labels/<id>.jpg      (downscaled web variant; bboxes stay in ORIGINAL px)

Run: ../VLM-DENTAL/.venv/Scripts/python.exe scripts/generate_m5_labels.py
"""
import json
import os
import sys

VLM = r"c:/Users/rezax/Home/Code/VLM-DENTAL"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COCO = os.path.join(
    VLM, "data", "dentex", "DENTEX", "training_data",
    "quadrant-enumeration-disease", "train_quadrant_enumeration_disease.json",
)
XRAYS = os.path.join(VLM, "data", "dentex", "DENTEX", "training_data",
                     "quadrant-enumeration-disease", "xrays")
MODEL = os.path.join(VLM, "data", "models", "yolo_cv_best", "weights", "best.pt")
IMAGE_IDS = [1, 2, 3, 4, 5]
MAX_W = 1600
LICENSE = "DENTEX (CC-BY-NC-SA-4.0); redistributed as downscaled derivative for research use"

# DENTEX diagnosis id -> label, identical to DENTEX_DEFAULT_DIAGNOSES in
# VLM-DENTAL/scripts/run_zero_shot.py (categories[] is empty in the COCO file).
DIAG = {0: "Impacted", 1: "Caries", 2: "Periapical Lesion", 3: "Deep Caries"}

OUT_LABELS = os.path.join(ROOT, "fixtures", "labels")
OUT_IMAGES = os.path.join(ROOT, "public", "labels")
os.makedirs(OUT_LABELS, exist_ok=True)
os.makedirs(OUT_IMAGES, exist_ok=True)

with open(COCO, encoding="utf-8") as fh:
    coco = json.load(fh)
images = {im["id"]: im for im in coco["images"]}
anns_by_img: dict = {}
for a in coco["annotations"]:
    anns_by_img.setdefault(a["image_id"], []).append(a)


def build_gt(image_id: int) -> list:
    out = []
    for i, a in enumerate(sorted(anns_by_img.get(image_id, []), key=lambda r: r["bbox"][0])):
        # THE single DENTEX 0-index conversion (fdi.ts dentexRowToFdi): +1, +1.
        q, pos = a["category_id_1"] + 1, a["category_id_2"] + 1
        x, y, w, h = a["bbox"]
        out.append({
            "id": f"gt_{image_id}_{i}",
            "bbox": [float(x), float(y), float(w), float(h)],
            "fdi_quadrant": q,
            "fdi_position": pos,
            "pathology": DIAG.get(int(a["category_id_3"]), "Caries"),
            "source": "gt_import",
            "confidence": None,
            "status": "approved",
            "version": 1,
            "author_id": "dentex_consensus",
        })
    return out


def cross_check(image_id: int, gt: list) -> None:
    """GT must equal the committed trace fixture GT (same source, same order key)."""
    trace_files = {1: "verified_with_tools", 3: "verified_healthy", 4: "unverified_dentex"}
    tf = trace_files.get(image_id)
    if not tf:
        return
    with open(os.path.join(ROOT, "fixtures", "traces", tf + ".json"), encoding="utf-8") as fh:
        trace = json.load(fh)
    tmap = {(f["quadrant"], f["tooth_position"]): f for f in trace["ground_truth"]}
    assert len(tmap) == len(gt), f"image {image_id}: trace {len(tmap)} vs coco {len(gt)}"
    for g in gt:
        key = (g["fdi_quadrant"], g["fdi_position"])
        assert key in tmap, f"image {image_id}: missing {key} in trace"
        t = tmap[key]
        assert t["diagnosis"] == g["pathology"], f"{key}: {t['diagnosis']} != {g['pathology']}"
        assert [float(v) for v in t["bbox"]] == g["bbox"], f"{key}: bbox mismatch"
    print(f"  cross-check image {image_id} vs {tf}: OK ({len(gt)} boxes)")


def make_variant(image_id: int, src: str) -> tuple[int, int, int, int]:
    """Downscale to <=1600px wide JPEG in public/labels; return dims tuple."""
    from PIL import Image

    with Image.open(src) as im:
        im = im.convert("L")
        w, h = im.size
        scale = min(1.0, MAX_W / w)
        vw, vh = max(1, round(w * scale)), max(1, round(h * scale))
        if scale < 1.0:
            im = im.resize((vw, vh), Image.LANCZOS)
        dst = os.path.join(OUT_IMAGES, f"{image_id}.jpg")
        im.save(dst, "JPEG", quality=85, optimize=True)
    return w, h, vw, vh


def run_yolo(image_id: int, src: str, native_w: int, native_h: int):
    """Real inference with the committed CV model (replay tier pre-labels)."""
    try:
        from ultralytics import YOLO
    except ImportError:
        return None, None
    model = YOLO(MODEL)
    res = model.predict(src, verbose=False, conf=0.25)[0]
    boxes = []
    for b in res.boxes:
        cls = int(b.cls.item())
        cx, cy, bw, bh = [float(v) for v in b.xywhn[0].tolist()]
        # Model trained on the 32-tooth yolo_dentex class list: idx -> FDI.
        q, pos = cls // 8 + 1, cls % 8 + 1
        boxes.append({
            "bbox": [cx * native_w, cy * native_h, bw * native_w, bh * native_h],
            "fdi_quadrant": q,
            "fdi_position": pos,
            "confidence": round(float(b.conf.item()), 6),
            "class_idx": cls,
        })
    boxes.sort(key=lambda b: -b["confidence"])
    return boxes, "yolo_cv_best"


print("generating M5 label fixtures...")
for iid in IMAGE_IDS:
    meta = images.get(iid)
    assert meta is not None, f"image id {iid} missing from COCO json"
    src = os.path.join(XRAYS, meta["file_name"])
    assert os.path.exists(src), f"missing xray: {src}"
    gt = build_gt(iid)
    cross_check(iid, gt)
    w, h, vw, vh = make_variant(iid, src)
    preds, model_name = run_yolo(iid, src, w, h)
    fixture = {
        "id": f"{iid}",
        "dataset": "dentex",
        "image_path": f"/labels/{iid}.jpg",
        "width": w,
        "height": h,
        "variant_width": vw,
        "variant_height": vh,
        "source_file": meta["file_name"],
        "license": LICENSE,
        "gt": gt,
        "predictions": preds,
        "prediction_model": model_name,
    }
    dst = os.path.join(OUT_LABELS, f"{iid}.json")
    with open(dst, "w", encoding="utf-8") as fh:
        json.dump(fixture, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    n_pred = len(preds) if preds else 0
    mean_conf = (sum(p["confidence"] for p in preds) / n_pred) if n_pred else None
    conf_s = round(mean_conf, 3) if mean_conf else None
    print(f"  image {iid}: {meta['file_name']} {w}x{h} -> variant {vw}x{vh}, "
          f"gt={len(gt)}, preds={n_pred}, mean_conf={conf_s}")

print("done.")
