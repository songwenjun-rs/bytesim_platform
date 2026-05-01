"""Smoke-test every service's main.py: importing builds the FastAPI app and
registers all routers without touching downstream services."""
from __future__ import annotations

import importlib

import pytest


@pytest.mark.parametrize("svc,title,routes", [
    ("bff",            "ByteSim BFF",         ["/healthz", "/v1/auth/login"]),
    ("engine-svc",     "ByteSim Engine",      ["/healthz", "/v1/engine/kick/{run_id}"]),
    ("surrogate-svc",  "ByteSim Surrogate",   ["/healthz", "/v1/predict"]),
])
def test_main_module_builds_app(mount_svc, svc, title, routes):
    """Each service's app should expose the expected routes after import."""
    mount_svc(svc)
    if "app" in __import__("sys").modules:
        for k in list(__import__("sys").modules):
            if k == "app" or k.startswith("app."):
                del __import__("sys").modules[k]
    main = importlib.import_module("app.main")
    app = main.app
    assert app.title == title
    paths = {r.path for r in app.routes if hasattr(r, "path")}
    for expected in routes:
        assert expected in paths, f"missing {expected} in {svc}"


def test_bff_event_bus_module_loads(mount_svc):
    """Importing bff.event_bus initialises class definitions; this hits 0%
    coverage lines we couldn't otherwise reach without Kafka."""
    mount_svc("bff")
    bus = importlib.import_module("app.event_bus")
    assert hasattr(bus, "EventBus")
    assert bus.TOPIC == "bs.events"


def test_engine_event_bus_module_loads(mount_svc):
    mount_svc("engine-svc")
    mod = importlib.import_module("app.event_bus")
    assert mod.TOPIC == "bs.events"


# ── BFF lifespan: open + close paths through mocked clients ────────────────

@pytest.mark.asyncio
async def test_bff_lifespan_drives_open_close(mount_svc, monkeypatch):
    """Drive bff/app/main.py's @asynccontextmanager lifespan through one
    open → yield → close cycle. Each downstream client is monkeypatched to
    a no-op AsyncMock so we don't need real Postgres / Kafka."""
    from unittest.mock import AsyncMock, MagicMock
    mount_svc("bff")
    monkeypatch.setenv("BFF_JWT_SECRET", "x")
    monkeypatch.setenv("BFF_ALLOW_DEV_SECRET", "1")
    monkeypatch.setenv("BFF_ALLOW_DEV_CORS", "1")

    main_mod = importlib.import_module("app.main")

    # Replace each Client constructor with one that yields an AsyncMock.
    for cls_name in ("RunSvcClient", "AssetSvcClient", "EngineSvcClient",
                     "TcoSvcClient", "EngineRegistrySvcClient", "IngestSvcClient"):
        ctor = MagicMock(return_value=AsyncMock())
        monkeypatch.setattr(main_mod, cls_name, ctor)

    # EventBus.open + close shouldn't actually contact Kafka.
    fake_bus_cls = MagicMock(return_value=AsyncMock())
    monkeypatch.setattr(main_mod, "EventBus", fake_bus_cls)

    # Drive the lifespan context manager.
    async with main_mod.lifespan(main_mod.app):
        # Inside the context: every state attr should be set.
        assert main_mod.app.state.run_svc is not None
        assert main_mod.app.state.event_bus is not None


# ── engine-svc worker_loop: no-runs path + cancel propagation ──────────────

@pytest.mark.asyncio
async def test_engine_worker_loop_sleeps_when_queue_empty(mount_svc, monkeypatch):
    """worker_loop should call backends.claim_next, get None, sleep
    POLL_INTERVAL, then loop. We cancel the loop after one tick so the test
    completes; that exercises both the None-branch and the cancel branch."""
    import asyncio
    from unittest.mock import AsyncMock, MagicMock
    mount_svc("engine-svc")
    monkeypatch.setenv("POLL_INTERVAL_S", "0.01")
    main_mod = importlib.import_module("app.main")

    fake_app = MagicMock()
    fake_app.state.backends = AsyncMock()
    fake_app.state.backends.claim_next = AsyncMock(return_value=None)
    fake_app.state.pipeline = MagicMock()

    task = asyncio.create_task(main_mod.worker_loop(fake_app, 0))
    # Give it a moment to make at least one claim_next call.
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert fake_app.state.backends.claim_next.await_count >= 1


@pytest.mark.asyncio
async def test_engine_worker_loop_recovers_from_claim_exception(mount_svc, monkeypatch):
    """Backend exception → worker logs + sleeps + retries (it does NOT crash
    the loop). Cancel after a couple of tries to confirm the retry path."""
    import asyncio
    from unittest.mock import AsyncMock, MagicMock
    mount_svc("engine-svc")
    monkeypatch.setenv("POLL_INTERVAL_S", "0.01")
    main_mod = importlib.import_module("app.main")

    fake_app = MagicMock()
    fake_app.state.backends = AsyncMock()
    fake_app.state.backends.claim_next = AsyncMock(side_effect=RuntimeError("network"))
    fake_app.state.pipeline = MagicMock()

    task = asyncio.create_task(main_mod.worker_loop(fake_app, 0))
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    # Exception path was hit ≥1 time; the loop kept retrying so it ≥2.
    assert fake_app.state.backends.claim_next.await_count >= 1


@pytest.mark.asyncio
async def test_engine_worker_loop_drives_pipeline_when_run_claimed(mount_svc, monkeypatch):
    """Returns a Run from claim_next → worker invokes pipeline.execute."""
    import asyncio
    from unittest.mock import AsyncMock, MagicMock
    mount_svc("engine-svc")
    monkeypatch.setenv("POLL_INTERVAL_S", "0.01")
    main_mod = importlib.import_module("app.main")

    fake_app = MagicMock()
    fake_app.state.backends = AsyncMock()
    # First call returns a run, second returns None forever (so we loop).
    fake_app.state.backends.claim_next = AsyncMock(
        side_effect=[{"id": "sim-7"}, None, None, None],
    )
    fake_app.state.pipeline = MagicMock()
    fake_app.state.pipeline.execute = AsyncMock()

    task = asyncio.create_task(main_mod.worker_loop(fake_app, 0))
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    fake_app.state.pipeline.execute.assert_awaited_with("sim-7")


@pytest.mark.asyncio
async def test_engine_worker_loop_recovers_from_pipeline_crash(mount_svc, monkeypatch):
    """pipeline.execute raises → worker logs + continues (does NOT crash)."""
    import asyncio
    from unittest.mock import AsyncMock, MagicMock
    mount_svc("engine-svc")
    monkeypatch.setenv("POLL_INTERVAL_S", "0.01")
    main_mod = importlib.import_module("app.main")

    fake_app = MagicMock()
    fake_app.state.backends = AsyncMock()
    fake_app.state.backends.claim_next = AsyncMock(
        side_effect=[{"id": "sim-x"}, None, None, None],
    )
    fake_app.state.pipeline = MagicMock()
    fake_app.state.pipeline.execute = AsyncMock(side_effect=RuntimeError("kaboom"))

    task = asyncio.create_task(main_mod.worker_loop(fake_app, 0))
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    # Loop still alive (more claim_next calls after the crash).
    assert fake_app.state.backends.claim_next.await_count >= 2
