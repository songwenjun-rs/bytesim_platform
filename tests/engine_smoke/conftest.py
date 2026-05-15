"""engine_smoke harness — make `shared/` and each engine svc importable.

Runs the smoke matrix declared by each engine's `EngineDescriptor` against
its in-process FastAPI app (TestClient). Catches three classes of drift:

  • envelope drift   — engine declares coverage it can't actually produce
  • response drift   — engine returns shapes that fail the contract
  • KPI regression   — model changes push KPI ranges outside what's expected
"""
from __future__ import annotations

import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

# Shared packages always on path.
for sub in ("shared",):
    p = os.path.join(ROOT, sub)
    if p not in sys.path:
        sys.path.insert(0, p)
