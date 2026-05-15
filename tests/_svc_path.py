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

_TIER = {
    "bff":                 "gateway",
    "data_svc":            "backend",
    "engine_svc":          "backend",
    "engine_registry_svc": "backend",
    "surrogate_svc":       "backend",
    "bytesim_svc":         "backend",
    "tco_engine_svc":      "backend",
    "web":                 "frontend",
}


def svc_path(root: str | os.PathLike, svc: str) -> str:
    """Return the post-split path for `<root>/<tier>/<svc>/`."""
    return os.path.join(str(root), _TIER[svc], svc)


def svc_path_p(root: Path, svc: str) -> Path:
    """Path-flavoured variant for tests that work with pathlib.Path."""
    return Path(root) / _TIER[svc] / svc
