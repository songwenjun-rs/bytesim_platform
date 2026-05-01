"""engine_contracts test fixtures — make `shared/` importable.

Module-level sys.path manipulation: pytest evaluates this conftest before
collecting test modules, so `from engine_contracts import ...` at the top of
each test resolves to `shared/engine_contracts/`.

Note: there is **no** `__init__.py` in this dir — making it a package would
shadow the `engine_contracts` name with this test directory itself.
"""
from __future__ import annotations

import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SHARED_PATH = os.path.join(ROOT, "shared")
if SHARED_PATH not in sys.path:
    sys.path.insert(0, SHARED_PATH)
