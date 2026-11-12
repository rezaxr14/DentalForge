# Third-Party Notices

This project incorporates the following third-party works, each governed by
its own licence. **The terms below apply regardless of this repository's
licence and survive any relicensing event.**

## DENTEX Dataset
- **Source**: `https://github.com/.../DENTEX` (official release)
- **Licence**: Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)
- **Licence Text**: https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode
- **Usage in this project**: 22 radiographs and 38 training traces (ground-truth annotations) are derived from DENTEX. The demo bundle contains only DENTEX data; Tufts data is excluded by construction and by sanitiser guard.

## Ultralytics YOLO
- **Source**: `https://github.com/ultralytics/ultralytics`
- **Licence**: GNU Affero General Public License v3.0 (AGPL-3.0)
- **Licence Text**: https://www.gnu.org/licenses/agpl-3.0.html
- **Usage in this project**: YOLOv8m trained exclusively on DENTEX (the "DENTEX-only weights"). The training invocation and `cv_results.json` are recorded in the demo bundle provenance. No ONNX export is published by this repository, so no ONNX artifact carries this obligation today.

## VLM-DENTAL Upstream
- **Source**: `https://github.com/rezaxr14/vlm-dental`
- **Status**: Private/pre-publication (same copyright holder)
- **Usage**: Compatibility layer (ADR-0030), trace/eval shapes, tool definitions, model backends (ADR-0031). No VLM-DENTAL code is copied into this repository; the compatibility probe (`vlm_compat.py`) reads the upstream checkout read-only at runtime.

## Runtime Dependencies (Node.js / Python)
All transitive dependencies are listed in `package.json` (Node) and `examples/python-worker/requirements-*.txt` (Python). Each carries its own licence (MIT, Apache-2.0, BSD, etc.). See `pnpm licenses list` for the full Node dependency graph.

---
**Compliance note**: If you redistribute this work (after the Apache-2.0 conversion), you MUST include this notice and the upstream licence texts for DENTEX (CC BY-NC-SA 4.0) and YOLO (AGPL-3.0). The AGPL-3.0 requires you to offer source code for the YOLO weights and training pipeline to anyone who receives the binary/ONNX artefacts.