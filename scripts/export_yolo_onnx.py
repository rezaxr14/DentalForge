"""
Export the DENTEX-only fold-0 checkpoint to the ONNX graph the browser ships
(ADR-0027).

Run outside CI: it needs `ultralytics`, `torch`, `onnx` and `onnxslim`, plus a
read-only copy of the VLM-DENTAL checkpoint. The checkpoint is copied to a temp
directory first, so nothing is ever written into the upstream repository.

    python scripts/export_yolo_onnx.py
    python scripts/export_yolo_onnx.py --checkpoint <path/to/best.pt> --outdir %TEMP%/export

Two steps, both measured:

1. Ultralytics writes a static 640x640, opset-17, simplified **fp32** graph.
   `half=True` is NOT used: it writes an identical fp32 file in this version.
2. Convert the weights to fp16 with `onnxconverter_common` while keeping the I/O
   tensors float32 (`images` [1,3,640,640], `output0` [1,36,8400]). The recipe
   is exact: delete the stale `value_info`, convert with
   `op_block_list=["Resize"]`, delete `value_info` again, re-run shape
   inference, `check_model`. Skipping the `value_info` deletion produces a graph
   ONNX Runtime refuses to load ("Resize" output type mismatch).
   `onnxslim --dtype fp16` also produces a loadable fp16 graph, but a
   byte-different one (51,897,297 bytes), so it is not what the shipped file
   came from.

The shipped file is 51,878,944 bytes with SHA-256
f0fda3500765a43d5248207969bd537d0e7605adc95ef740baafa0486f9e3350. Ultralytics
embeds the export timestamp in the graph metadata, so a re-run has a different
raw hash and the same graph; this script therefore compares the graph digest
with the `date` field blanked, and fails on any other difference. A deliberate
change must update YOLO_MODEL in src/shared/domain/yolo/model.ts,
MODEL_BYTES/MODEL_SHA256 in scripts/prepare-yolo-assets.mjs and ADR-0027
together.
"""
import argparse
import hashlib
import os
import shutil
import tempfile

EXPECTED_BYTES = 51_878_944
EXPECTED_SHA256 = "f0fda3500765a43d5248207969bd537d0e7605adc95ef740baafa0486f9e3350"
EXPECTED_GRAPH_SHA256 = "a9e3300ae0abfa3e51e9c55769fc38df265cce9530bea08a7c8154814c50f05a"
DEFAULT_CHECKPOINT = os.path.join(
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")),
    "VLM-DENTAL",
    "data",
    "models",
    "dentex_only_fold_0",
    "weights",
    "best.pt",
)


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def graph_sha256(path):
    """Hash the graph with the export timestamp blanked (Ultralytics writes it)."""
    import onnx

    model = onnx.load(path)
    for prop in model.metadata_props:
        if prop.key == "date":
            prop.value = ""
    return hashlib.sha256(model.SerializeToString()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--checkpoint",
        default=os.environ.get("DENTEX_CHECKPOINT", DEFAULT_CHECKPOINT),
        help="DENTEX-only fold-0 best.pt (read-only; copied before export)",
    )
    parser.add_argument(
        "--outdir",
        default=os.path.join(os.path.dirname(__file__), "..", "public", "models", "yolo"),
        help="where the fp16 graph is written",
    )
    args = parser.parse_args()

    checkpoint = os.path.abspath(args.checkpoint)
    outdir = os.path.abspath(args.outdir)
    if not os.path.isfile(checkpoint):
        raise SystemExit(f"checkpoint not found: {checkpoint}")
    os.makedirs(outdir, exist_ok=True)

    from ultralytics import YOLO

    with tempfile.TemporaryDirectory(prefix="df-yolo-export-") as tmp:
        # Never write next to the upstream weights: copy first.
        local = os.path.join(tmp, "best.pt")
        shutil.copy2(checkpoint, local)
        print(f"export: fp32 from {checkpoint}")
        fp32 = YOLO(local).export(
            format="onnx",
            imgsz=640,
            opset=17,
            simplify=True,
            dynamic=False,
            half=False,
        )
        fp32 = os.path.abspath(str(fp32))
        print(f"export: fp32 {os.path.getsize(fp32):,} bytes -> {fp32}")

        from onnxconverter_common import float16
        import onnx

        final = os.path.join(outdir, "yolov8m-dentex-fp16-640.onnx")
        model = onnx.load(fp32)
        # Stale value_info carries fp32 types and makes the Resize cast fail.
        del model.graph.value_info[:]
        converted = float16.convert_float_to_float16(
            model, keep_io_types=True, op_block_list=["Resize"]
        )
        del converted.graph.value_info[:]
        converted = onnx.shape_inference.infer_shapes(converted, strict_mode=False)
        onnx.checker.check_model(converted)
        onnx.save(converted, final)

    model = onnx.load(final)
    for tensor in (*model.graph.input, *model.graph.output):
        dims = [d.dim_value for d in tensor.type.tensor_type.shape.dim]
        print(f"export: {tensor.name} {dims} elem_type={tensor.type.tensor_type.elem_type}")

    size = os.path.getsize(final)
    digest = sha256(final)
    graph = graph_sha256(final)
    print(f"export: {final}")
    print(f"export: bytes={size:,} mib={size / 1048576:.1f} sha256={digest}")
    print(f"export: shipped sha256={EXPECTED_SHA256} (raw hashes differ by the export date)")
    if size != EXPECTED_BYTES:
        raise SystemExit(f"export: {size:,} bytes, expected {EXPECTED_BYTES:,}")
    if graph != EXPECTED_GRAPH_SHA256:
        raise SystemExit(
            "export: the graph differs from the shipped one. If that is intended, "
            "update model.ts, prepare-yolo-assets.mjs and ADR-0027 in the same commit."
        )
    print(f"export: graph digest {graph} matches the shipped graph")


if __name__ == "__main__":
    main()
