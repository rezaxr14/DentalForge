"""
Write the browser-YOLO golden fixtures (ADR-0027).

Runs the fp32 ONNX export over three held-out DENTEX validation images with the
same letterbox the browser uses, keeps every anchor whose best class score is at
least 0.25, and records the decoded boxes. The TypeScript decoder
(`src/shared/domain/yolo/detect.ts`) must reproduce those boxes in CI, without
onnxruntime and without the 50 MB model.

Run: python scripts/export_yolo_golden.py
Reads: $TEMP/df-yolo-export/yolov8m-dentex-fp32-640.onnx and VLM-DENTAL's DENTEX
validation xrays (read-only). Writes: fixtures/yolo/<image>.json
"""
import json
import os

import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VLM = os.environ.get(
    "VLM_DENTAL_PATH",
    os.path.abspath(os.path.join(ROOT, "..", "VLM-DENTAL")),
)
XRAYS = os.path.join(
    VLM, "data", "dentex", "DENTEX", "validation_data",
    "quadrant_enumeration_disease", "xrays",
)
MODEL = os.path.join(os.environ["TEMP"], "df-yolo-export", "yolov8m-dentex-fp32-640.onnx")
OUT = os.path.join(ROOT, "fixtures", "yolo")
IMAGES = ["val_18", "val_32", "val_44"]
SIZE, PAD, CONF, IOU = 640, 114, 0.25, 0.45


def letterbox(w, h):
    scale = min(SIZE / w, SIZE / h)
    nw, nh = round(w * scale), round(h * scale)
    return scale, nw, nh, round((SIZE - nw) / 2 - 0.1), round((SIZE - nh) / 2 - 0.1)


def preprocess(path):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    scale, nw, nh, left, top = letterbox(w, h)
    im = im.resize((nw, nh), Image.BILINEAR)
    canvas = Image.new("RGB", (SIZE, SIZE), (PAD, PAD, PAD))
    canvas.paste(im, (left, top))
    arr = np.asarray(canvas, dtype=np.float32) / 255.0
    return np.ascontiguousarray(arr.transpose(2, 0, 1)[None]), (w, h, scale, nw, nh, left, top)


def iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def nms(boxes, scores, thr):
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(int(i))
        rest = order[1:]
        if not rest.size:
            break
        ov = np.array([iou(boxes[i], boxes[j]) for j in rest])
        order = rest[ov <= thr]
    return keep


def decode(rows, meta):
    w, h, scale, nw, nh, left, top = meta
    cx, cy, bw, bh = rows[:, 0], rows[:, 1], rows[:, 2], rows[:, 3]
    scores = rows[:, 4:]
    conf = scores.max(axis=1)
    cls = scores.argmax(axis=1)
    m = conf >= CONF
    cx, cy, bw, bh, conf, cls = cx[m], cy[m], bw[m], bh[m], conf[m], cls[m]
    xyxy = np.stack([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], axis=1)
    keep = nms(xyxy, conf, IOU)
    out = []
    for i in keep:
        x1, y1, x2, y2 = xyxy[i]
        x1 = min(max((x1 - left) / scale, 0.0), w)
        x2 = min(max((x2 - left) / scale, 0.0), w)
        y1 = min(max((y1 - top) / scale, 0.0), h)
        y2 = min(max((y2 - top) / scale, 0.0), h)
        out.append({
            "bbox": [round(float(x1), 6), round(float(y1), 6),
                     round(float(x2 - x1), 6), round(float(y2 - y1), 6)],
            "confidence": round(float(conf[i]), 6),
            "classIdx": int(cls[i]),
        })
    out.sort(key=lambda b: -b["confidence"])
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    sess = ort.InferenceSession(MODEL, so, providers=["CPUExecutionProvider"])
    for name in IMAGES:
        tensor, meta = preprocess(os.path.join(XRAYS, f"{name}.png"))
        pred = sess.run(None, {sess.get_inputs()[0].name: tensor})[0][0].T  # (8400, 36)
        best = pred[:, 4:].max(axis=1)
        rows = pred[best >= CONF]
        fixture = {
            "image": name,
            "meta": {
                "width": meta[0], "height": meta[1], "size": SIZE,
                "scale": round(meta[2], 10), "left": meta[5], "top": meta[6],
                "scaledWidth": meta[3], "scaledHeight": meta[4], "pad": PAD,
            },
            "confidenceThreshold": CONF,
            "iouThreshold": IOU,
            "anchors": [[round(float(v), 6) for v in row] for row in rows],
            "expected": decode(rows, meta),
        }
        path = os.path.join(OUT, f"{name}.json")
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(fixture, fh, indent=1)
            fh.write("\n")
        print(f"{name}: {len(rows)} candidate anchors, {len(fixture['expected'])} boxes, "
              f"{os.path.getsize(path)} bytes")


if __name__ == "__main__":
    main()
