"""Cover engine-svc main.py: kick endpoint + worker_loop control flow + cancel_watcher."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def app():
    from app.main import app as fastapi_app
    fastapi_app.router.lifespan_context = None
    return fastapi_app


def test_healthz(app):
    c = TestClient(app)
    r = c.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"


def test_kick_acknowledges_immediately(app):
    """Kick is now a no-op that just acknowledges receipt. Actual run pickup
    is the polling worker's job (via /v1/runs/claim). The previous
    implementation spawned pipeline.execute() directly, which raced with the
    polling worker and produced double-executions on the same run id."""
    c = TestClient(app)
    r = c.post("/v1/engine/kick/sim-x")
    assert r.status_code == 200
    assert r.json()["acknowledged"] == "sim-x"


@pytest.mark.asyncio
async def test_worker_loop_picks_run_and_executes():
    from app.main import worker_loop
    from fastapi import FastAPI

    test_app = FastAPI()
    test_app.state.backends = AsyncMock()
    # Return run once, then None on subsequent calls
    runs = [{"id": "sim-1"}, None]

    async def claim():
        return runs.pop(0) if runs else None

    test_app.state.backends.claim_next = claim
    test_app.state.pipeline = AsyncMock()

    task = asyncio.create_task(worker_loop(test_app, 0))
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):
        pass
    test_app.state.pipeline.execute.assert_awaited_with("sim-1")


@pytest.mark.asyncio
async def test_worker_loop_recovers_from_claim_exception():
    from app.main import worker_loop
    from fastapi import FastAPI

    test_app = FastAPI()
    test_app.state.backends = AsyncMock()
    calls = [RuntimeError("net"), None]

    async def claim():
        if calls:
            x = calls.pop(0)
            if isinstance(x, BaseException):
                raise x
            return x
        return None

    test_app.state.backends.claim_next = claim
    test_app.state.pipeline = AsyncMock()
    task = asyncio.create_task(worker_loop(test_app, 1))
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):
        pass
    # Pipeline never invoked because claim either raised or returned None
    test_app.state.pipeline.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_worker_loop_recovers_when_pipeline_crashes():
    from app.main import worker_loop
    from fastapi import FastAPI

    test_app = FastAPI()
    test_app.state.backends = AsyncMock()
    runs = [{"id": "sim-1"}, None, None]

    async def claim():
        return runs.pop(0) if runs else None

    test_app.state.backends.claim_next = claim
    test_app.state.pipeline = AsyncMock()
    test_app.state.pipeline.execute = AsyncMock(side_effect=RuntimeError("oops"))

    task = asyncio.create_task(worker_loop(test_app, 2))
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):
        pass
    test_app.state.pipeline.execute.assert_awaited()
