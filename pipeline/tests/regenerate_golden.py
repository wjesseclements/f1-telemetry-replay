#!/usr/bin/env python3
"""
Rewrite the committed goldens from the current pipeline.

Run this after an INTENTIONAL change to `replay_transform.py`, then read the diff —
it is the change's effect on real output, which is the only place that effect is
visible without network access. `tests/test_golden.py` fails until you do.

    cd pipeline && python tests/regenerate_golden.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from replay_transform import dump_json  # noqa: E402
from test_golden import CASES, GOLDEN_DIR, generate  # noqa: E402


def main() -> int:
    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
    for name in sorted(CASES):
        path = GOLDEN_DIR / f"{name}.golden.json"
        path.write_text(dump_json(generate(name)))
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
