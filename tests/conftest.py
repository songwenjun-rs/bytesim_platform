"""Top-level conftest — make `app` packages importable from each service.

Each service ships its FastAPI app under `services/<svc>/app/`. We can't
import them all at once because they share the top-level `app` module name,
so per-test we manipulate sys.path within that test file's fixture. This
file just ensures pytest discovers tests under tests/."""
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)

# RFC-001 v2: every engine svc + the registry imports `engine_contracts` /
# `engine_runtime` from the shared/ package directory. Putting it on sys.path
# at root conftest level means each per-svc conftest can keep its own
# isolation logic unchanged.
SHARED = os.path.join(ROOT, "shared")
if SHARED not in sys.path:
    sys.path.insert(0, SHARED)
