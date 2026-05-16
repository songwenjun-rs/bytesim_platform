"""Service-name → tier-prefixed path mapping for cross-service tests.

After the Phase 3 split, services live under three tier dirs. The
parameterized cross-service tests still ask for a service by its bare
name (the historical layout under services/<name>/); this helper returns
the post-split submodule path.

Cross-service tests are inherently fragile after the split — each submodule
has its own venv / dep set. These helpers exist to keep the existing
integration tests path-correct; running them all in one Python process
remains a separate problem (set up isolated venvs per service or call
each service over HTTP instead).
"""
from __future__ import annotations

import os
from pathlib import Path

# Post-restructure layout (May 2026): top-level dirs for the SPA + gateway,
# `service/` parent for the 5 backend Python/Go services (P3 merge:
# engine_registry_svc was absorbed into engine_svc; rename: tco_engine_svc
# → tco_svc).
_PATH = {
    "bff":           "bff",
    "dashboard":     "dashboard",
    "web":           "dashboard",   # legacy alias
    "data_svc":      "service/data_svc",
    "engine_svc":    "service/engine_svc",
    "surrogate_svc": "service/surrogate_svc",
    "bytesim_svc":   "service/bytesim_svc",
    "tco_svc":       "service/tco_svc",
}


def svc_path(root: str | os.PathLike, svc: str) -> str:
    """Return the post-restructure path for the service's submodule root."""
    return os.path.join(str(root), _PATH[svc])


def svc_path_p(root: Path, svc: str) -> Path:
    """Path-flavoured variant for tests that work with pathlib.Path."""
    return Path(root) / _PATH[svc]
