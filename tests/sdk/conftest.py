"""SDK tests run against the real BFF FastAPI app over a real local socket.

We spin up uvicorn in a background thread (one server, module-scoped) so
sync httpx in the SDK can hit it without any transport wiring. Catches the
cases where the SDK and BFF disagree on path/payload shape, which mocked
tests would miss.
"""
from __future__ import annotations

import os
import socket
import sys
import threading
import time
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
import uvicorn

ROOT = Path(__file__).resolve().parents[2]
BFF_PATH = ROOT / "services" / "bff"

os.environ.setdefault("BFF_JWT_SECRET", "sdk-test-secret")
os.environ.setdefault("BFF_JWT_TTL", "3600")


@pytest.fixture(autouse=True)
def _isolate_bff_path():
    """Mount BFF on sys.path the same way bff tests do."""
    saved_path = list(sys.path)
    saved_mods = {k: v for k, v in sys.modules.items() if k == "app" or k.startswith("app.")}
    for k in list(saved_mods):
        del sys.modules[k]
    sys.path.insert(0, str(BFF_PATH))
    yield
    sys.path[:] = saved_path
    for k in list(sys.modules):
        if k == "app" or k.startswith("app."):
            del sys.modules[k]
    sys.modules.update(saved_mods)


@pytest.fixture
def bff_app():
    """Real BFF FastAPI app with downstream clients stubbed via AsyncMock."""
    from app.api import auth, runs, specs  # type: ignore
    from app.auth import AuthMiddleware  # type: ignore
    from fastapi import FastAPI

    app = FastAPI()
    app.add_middleware(AuthMiddleware)
    app.include_router(auth.router)
    app.include_router(runs.router)
    app.include_router(specs.router)

    @app.get("/healthz")
    def _hz(): return {"status": "ok"}

    app.state.run_svc = AsyncMock()
    app.state.asset_svc = AsyncMock()
    app.state.engine_svc = AsyncMock()
    app.state.event_bus = AsyncMock()
    return app


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture
def base_url(bff_app):
    """Run the BFF app in a uvicorn thread and yield its URL. Per-test so
    each test gets a fresh app instance (and therefore fresh AsyncMocks on
    app.state)."""
    port = _free_port()
    config = uvicorn.Config(bff_app, host="127.0.0.1", port=port, log_level="warning", lifespan="off")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    # wait for /healthz
    url = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        try:
            httpx.get(f"{url}/healthz", timeout=0.5)
            break
        except Exception:
            time.sleep(0.05)
    else:
        raise RuntimeError("BFF test server failed to start")
    yield url
    server.should_exit = True
    thread.join(timeout=3)




@pytest.fixture
def tmp_config_file(tmp_path, monkeypatch):
    """Isolate ~/.bytesim/config.toml to a temp dir for each test."""
    cfg_path = tmp_path / "config.toml"
    monkeypatch.setattr("bytesim.config.DEFAULT_PATH", cfg_path)
    return cfg_path


@pytest.fixture
def logged_in(bff_app, base_url, tmp_config_file):
    """Mint a real JWT against the live BFF and stash it in the temp config.
    Returns a fresh Client pointed at the test server."""
    from bytesim.auth import login
    cfg = login("songwenjun", base_url=base_url)
    from bytesim.client import Client
    client = Client(config=cfg)
    yield client
    client.close()
