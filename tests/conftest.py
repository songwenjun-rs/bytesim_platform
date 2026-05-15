"""Top-level conftest — sys.path setup for cross-service integration tests.

After the Phase 3 submodule split, each service's own tests live inside
its repo (bff/tests, backend/<svc>/tests, dashboard/src/__tests__).
This `tests/` directory keeps only the platform-level cross-service work:

  - engine_smoke/      contract harness across registered engines
  - db/                multi-service Postgres integration
  - main_modules/      each service's main.py importable at boot
  - sdk/               end-to-end through the user-facing SDK
  - engine_contracts/  schema-level shape + envelope_covers logic
  - tools/             platform tooling
  - generated/         codegen'd contract snapshot the tests import

Parameterised tests resolve service paths via tests/_svc_path.py
(svc_name → <tier>/<svc>).
"""
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)

TESTS = os.path.dirname(__file__)
if TESTS not in sys.path:
    sys.path.insert(0, TESTS)
