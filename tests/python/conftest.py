"""Make `examples/python-worker` modules importable from `tests/python`.

The worker is not a package (it is copied into a Colab/Kaggle session as loose files), so the tests
put its directory on `sys.path` instead of importing it as `examples.python_worker`.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKER = ROOT / "examples" / "python-worker"

for entry in (str(ROOT), str(WORKER)):
    if entry not in sys.path:
        sys.path.insert(0, entry)
