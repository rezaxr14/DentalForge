#!/usr/bin/env python3
"""Write (or check) `fixtures/worker/wp3-acceptance.json` from the real WP3 handlers.

    python examples/python-worker/record_acceptance.py --write   # regenerate (owner decision)
    python examples/python-worker/record_acceptance.py --check   # diff against the committed file

`--check` is what keeps the fixture honest: if a handler starts emitting a different event or result
shape, the committed recording no longer matches and the check fails with a readable diff. The pytest
suite validates the committed file against `docs/worker-openapi.json`; the vitest suite parses it with
the Zod contracts. Exit codes: 0 match/written, 1 drift, 2 the handlers could not be recorded.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from acceptance_fixtures import FIXTURE_PATH, record  # noqa: E402


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true", help="write the fixture")
    group.add_argument("--check", action="store_true", help="fail if the committed fixture is stale")
    args = parser.parse_args(argv)

    try:
        fresh = record()
    except Exception as e:  # noqa: BLE001 - the recorder is the thing under test here
        print(f"[acceptance] could not record the handlers: {type(e).__name__}: {e}", file=sys.stderr)
        return 2

    text = json.dumps(fresh, indent=2, sort_keys=False) + "\n"
    if args.write:
        FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE_PATH.write_text(text, encoding="utf-8")
        print(f"[acceptance] wrote {FIXTURE_PATH.relative_to(FIXTURE_PATH.parents[2])}")
        return 0

    if not FIXTURE_PATH.is_file():
        print(f"[acceptance] missing {FIXTURE_PATH}; run with --write", file=sys.stderr)
        return 1
    committed = FIXTURE_PATH.read_text(encoding="utf-8")
    if committed == text:
        print("[acceptance] fixture matches the handlers")
        return 0

    import difflib

    diff = difflib.unified_diff(
        committed.splitlines(keepends=True),
        text.splitlines(keepends=True),
        fromfile="committed",
        tofile="handlers",
        n=2,
    )
    sys.stderr.writelines(diff)
    print("[acceptance] DRIFT: the committed recording is stale; review the diff above", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
