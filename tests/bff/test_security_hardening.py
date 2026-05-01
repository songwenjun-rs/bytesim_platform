"""P0-A.0.2.{2,4} — security hardening regressions.

Locks the contract that:
  * BFF refuses to boot with the dev JWT secret unless BFF_ALLOW_DEV_SECRET=1
  * CORS allow_origins is env-driven; default is closed
"""
from __future__ import annotations

import sys

import pytest


# ── 0.2.2 · JWT secret strictness ─────────────────────────────────────

def test_assert_secret_raises_with_default_secret(monkeypatch):
    monkeypatch.delenv("BFF_JWT_SECRET", raising=False)
    monkeypatch.delenv("BFF_ALLOW_DEV_SECRET", raising=False)
    # Reload auth.py with the cleared env so JWT_SECRET picks up the default.
    for k in [k for k in sys.modules if k == "app" or k.startswith("app.")]:
        sys.modules.pop(k, None)
    from app.auth import assert_secret_configured  # type: ignore
    with pytest.raises(RuntimeError, match="BFF_JWT_SECRET"):
        assert_secret_configured()


def test_assert_secret_passes_with_explicit_secret(monkeypatch):
    monkeypatch.setenv("BFF_JWT_SECRET", "real-strong-secret-from-vault")
    monkeypatch.delenv("BFF_ALLOW_DEV_SECRET", raising=False)
    for k in [k for k in sys.modules if k == "app" or k.startswith("app.")]:
        sys.modules.pop(k, None)
    from app.auth import assert_secret_configured  # type: ignore
    assert_secret_configured()  # no raise


def test_assert_secret_passes_with_dev_optin(monkeypatch):
    monkeypatch.delenv("BFF_JWT_SECRET", raising=False)
    monkeypatch.setenv("BFF_ALLOW_DEV_SECRET", "1")
    for k in [k for k in sys.modules if k == "app" or k.startswith("app.")]:
        sys.modules.pop(k, None)
    from app.auth import assert_secret_configured  # type: ignore
    assert_secret_configured()  # opt-in is enough


# ── 0.2.4 · CORS env-driven origins ───────────────────────────────────
#
# We can't easily inspect FastAPI's middleware stack at runtime, so the
# test reads the resolved `_allowed_origins` list that main.py computes at
# import time. Reload main.py with different envs to drive each branch.

def _reload_main(monkeypatch, **env: str) -> list[str]:
    for k in [k for k in sys.modules if k == "app" or k.startswith("app.")]:
        sys.modules.pop(k, None)
    monkeypatch.delenv("BFF_CORS_ORIGINS", raising=False)
    monkeypatch.delenv("BFF_ALLOW_DEV_CORS", raising=False)
    monkeypatch.setenv("BFF_ALLOW_DEV_SECRET", "1")  # bypass secret check at import
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    import importlib
    import app.main as m  # type: ignore
    importlib.reload(m)
    return m._allowed_origins  # type: ignore[attr-defined]


def test_cors_default_is_closed(monkeypatch):
    origins = _reload_main(monkeypatch)
    assert origins == []


def test_cors_dev_optin_allows_localhost_vite(monkeypatch):
    origins = _reload_main(monkeypatch, BFF_ALLOW_DEV_CORS="1")
    assert "http://localhost:5173" in origins
    assert "http://127.0.0.1:5173" in origins


def test_cors_explicit_list_overrides_dev_optin(monkeypatch):
    origins = _reload_main(
        monkeypatch,
        BFF_CORS_ORIGINS="https://app.example.com,https://staging.example.com",
        BFF_ALLOW_DEV_CORS="1",  # ignored when explicit list is set
    )
    assert origins == ["https://app.example.com", "https://staging.example.com"]
