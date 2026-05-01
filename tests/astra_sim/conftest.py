"""astra-sim-svc test fixtures — mount services/astra-sim-svc on sys.path."""
from __future__ import annotations

import os
import sys

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SVC_PATH = os.path.join(ROOT, "services", "astra-sim-svc")

# Module-level path setup so tests that import `app.*` at module top
# (e.g. test_chakra_writer) work at collection time, not just inside the
# autouse fixture.
if SVC_PATH not in sys.path:
    sys.path.insert(0, SVC_PATH)


@pytest.fixture(autouse=True)
def _isolate_path():
    saved_path = list(sys.path)
    saved_mods = {k: v for k, v in sys.modules.items() if k == "app" or k.startswith("app.")}
    for k in list(saved_mods):
        del sys.modules[k]
    sys.path.insert(0, SVC_PATH)
    yield
    sys.path[:] = saved_path
    for k in list(sys.modules):
        if k == "app" or k.startswith("app."):
            del sys.modules[k]
    sys.modules.update(saved_mods)
