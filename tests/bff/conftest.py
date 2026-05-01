"""BFF test fixtures.

We mount services/bff onto sys.path so `from app...` resolves to BFF's app
package. Then we build a TestClient from the FastAPI app with the lifespan
disabled (no real downstream services) and inject mock clients into
app.state.
"""
from __future__ import annotations

import os
import sys
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BFF_PATH = os.path.join(ROOT, "services", "bff")

# Ensure deterministic JWT secret across the suite.
os.environ.setdefault("BFF_JWT_SECRET", "test-secret-fixed")
os.environ.setdefault("BFF_JWT_TTL", "3600")


@pytest.fixture(autouse=True)
def _isolate_path():
    """BFF imports `app`; force BFF onto path for these tests and pop any
    previously-imported `app` modules so we don't collide with other svcs."""
    saved_path = list(sys.path)
    saved_mods = {k: v for k, v in sys.modules.items() if k == "app" or k.startswith("app.")}
    for k in list(saved_mods):
        del sys.modules[k]
    sys.path.insert(0, BFF_PATH)
    yield
    sys.path[:] = saved_path
    for k in list(sys.modules):
        if k == "app" or k.startswith("app."):
            del sys.modules[k]
    sys.modules.update(saved_mods)


def _build_app_no_lifespan() -> Any:
    """Reach into bff.main, but build a fresh FastAPI without the lifespan
    that opens Kafka + httpx clients we don't have downstream."""
    from app.api import auth, runs, specs  # type: ignore
    from app.auth import AuthMiddleware  # type: ignore
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware

    app = FastAPI(title="ByteSim BFF (test)")
    app.add_middleware(AuthMiddleware)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    app.include_router(auth.router)
    app.include_router(runs.router)
    app.include_router(specs.router)

    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    # Stub downstream clients with AsyncMocks; tests override per-call.
    app.state.run_svc = AsyncMock()
    app.state.asset_svc = AsyncMock()
    app.state.engine_svc = AsyncMock()
    app.state.event_bus = AsyncMock()
    return app


@pytest.fixture
def app():
    return _build_app_no_lifespan()


@pytest.fixture
def client(app):
    return TestClient(app)


@pytest.fixture
def login_token(client):
    """Convenience: a fresh token for the seeded multi-project user."""
    r = client.post("/v1/auth/login", json={"user_id": "songwenjun", "password": "x"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture
def auth_headers(login_token):
    return {"Authorization": f"Bearer {login_token}", "X-Project-ID": "p_default"}
