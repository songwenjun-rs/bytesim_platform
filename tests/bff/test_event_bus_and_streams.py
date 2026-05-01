"""Cover bff/event_bus.py subscribe/unsubscribe + bff/api/{streams,artifacts}.py."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest


@pytest.mark.asyncio
async def test_event_bus_subscribe_unsubscribe_and_publish_noop():
    from app.event_bus import EventBus
    bus = EventBus()
    q1 = bus.subscribe()
    q2 = bus.subscribe()
    assert len(bus.subscribers) == 2
    bus.unsubscribe(q1)
    bus.unsubscribe(q1)  # idempotent
    assert q2 in bus.subscribers
    bus.unsubscribe(q2)
    assert bus.subscribers == []
    # publish before open() should be a silent no-op
    await bus.publish({"kind": "anything"})


@pytest.mark.asyncio
async def test_event_bus_loop_pushes_events_to_subscribers():
    """Drive the internal _loop manually with a fake consumer."""
    from app.event_bus import EventBus
    bus = EventBus()

    class _Record:
        def __init__(self, value):
            self.value = value

    class _FakeConsumer:
        def __init__(self, records):
            self.records = records

        def __aiter__(self):
            return self

        async def __anext__(self):
            if not self.records:
                raise StopAsyncIteration
            return self.records.pop(0)

    bus._consumer = _FakeConsumer([_Record({"kind": "run.started", "run_id": "x"})])
    q = bus.subscribe()
    await bus._loop()
    assert q.get_nowait()["kind"] == "run.started"


# ── EventBus.publish + close + loop edge cases ─────────────────────────────

@pytest.mark.asyncio
async def test_event_bus_publish_through_producer():
    """publish() forwards to AIOKafkaProducer.send_and_wait when producer is set."""
    from app.event_bus import EventBus
    bus = EventBus()
    fake_producer = AsyncMock()
    bus._producer = fake_producer
    await bus.publish({"kind": "run.cancelled", "run_id": "sim-1"})
    fake_producer.send_and_wait.assert_awaited_once()
    args, kwargs = fake_producer.send_and_wait.call_args
    assert kwargs["value"]["kind"] == "run.cancelled"
    assert kwargs["key"] == "sim-1"


@pytest.mark.asyncio
async def test_event_bus_publish_swallows_producer_errors(caplog):
    from app.event_bus import EventBus
    bus = EventBus()
    fake_producer = AsyncMock()
    fake_producer.send_and_wait.side_effect = RuntimeError("kafka down")
    bus._producer = fake_producer
    # Must not raise — failure is logged + swallowed.
    await bus.publish({"kind": "x"})


@pytest.mark.asyncio
async def test_event_bus_close_cancels_task_and_stops_components():
    from app.event_bus import EventBus
    bus = EventBus()
    bus._consumer = AsyncMock()
    bus._producer = AsyncMock()

    # Long-running task that close() should cancel.
    async def _spin():
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            raise
    bus._task = asyncio.create_task(_spin())
    await bus.close()
    assert bus._consumer is None
    assert bus._producer is None
    assert bus._task is None


@pytest.mark.asyncio
async def test_event_bus_loop_handles_full_subscriber_queue():
    """Slow subscriber whose queue is full doesn't block the loop — it just
    drops the event silently."""
    from app.event_bus import EventBus
    bus = EventBus()

    class _Record:
        def __init__(self, value):
            self.value = value

    class _FakeConsumer:
        def __init__(self, records):
            self.records = records

        def __aiter__(self): return self
        async def __anext__(self):
            if not self.records:
                raise StopAsyncIteration
            return self.records.pop(0)

    full_q: asyncio.Queue = asyncio.Queue(maxsize=1)
    full_q.put_nowait({"already": "filled"})
    bus.subscribers.append(full_q)
    bus._consumer = _FakeConsumer([_Record({"kind": "run.x"})])
    await bus._loop()
    # Original entry survives; new event was dropped due to QueueFull.
    assert full_q.get_nowait() == {"already": "filled"}


@pytest.mark.asyncio
async def test_event_bus_loop_swallows_consumer_exception():
    from app.event_bus import EventBus
    bus = EventBus()

    class _BoomConsumer:
        def __aiter__(self): return self
        async def __anext__(self):
            raise RuntimeError("kafka network down")

    bus._consumer = _BoomConsumer()
    # Must not propagate — exception path logs + returns cleanly.
    await bus._loop()


# ── bff/api/artifacts.py — streaming proxy ─────────────────────────────────

@pytest.mark.asyncio
async def test_proxy_artifact_streams_upstream_body(monkeypatch):
    """artifacts.proxy_artifact streams chunks from upstream verbatim and
    forwards Content-Length when present."""
    from app.api.artifacts import proxy_artifact

    chunks = [b"hello ", b"world"]

    class _UpstreamResp:
        status_code = 200
        headers = {"content-length": "11", "content-type": "text/plain"}

        async def aiter_bytes(self):
            for c in chunks:
                yield c

        async def aclose(self):
            pass

    async def _send(req, stream=False):
        return _UpstreamResp()

    fake_client = MagicMock()
    fake_client.send = _send
    fake_client.build_request = MagicMock(return_value="REQ")

    fake_request = MagicMock()
    fake_request.app.state.run_svc._client = fake_client

    resp = await proxy_artifact("sim-1", "engine.log", fake_request)
    # StreamingResponse exposes status_code + headers, body via body_iterator.
    assert resp.status_code == 200
    assert resp.headers["content-length"] == "11"
    assert resp.media_type == "text/plain"

    received = b""
    async for chunk in resp.body_iterator:
        received += chunk
    assert received == b"hello world"


@pytest.mark.asyncio
async def test_proxy_artifact_omits_content_length_when_upstream_lacks_it():
    from app.api.artifacts import proxy_artifact

    class _UpstreamResp:
        status_code = 200
        # No content-length header — common for chunked responses.
        headers = {"content-type": "application/octet-stream"}
        async def aiter_bytes(self):
            yield b"x"
        async def aclose(self):
            pass

    fake_client = MagicMock()
    fake_client.send = AsyncMock(return_value=_UpstreamResp())
    fake_client.build_request = MagicMock(return_value="REQ")
    fake_request = MagicMock()
    fake_request.app.state.run_svc._client = fake_client

    resp = await proxy_artifact("sim-1", "x.bin", fake_request)
    assert "content-length" not in resp.headers
    # Drain so aclose() runs (covers the finally branch).
    async for _ in resp.body_iterator:
        pass


@pytest.mark.asyncio
async def test_proxy_artifact_propagates_upstream_404():
    from app.api.artifacts import proxy_artifact

    class _UpstreamResp:
        status_code = 404
        headers = {"content-type": "text/plain"}
        async def aiter_bytes(self):
            yield b"not found"
        async def aclose(self):
            pass

    fake_client = MagicMock()
    fake_client.send = AsyncMock(return_value=_UpstreamResp())
    fake_client.build_request = MagicMock(return_value="REQ")
    fake_request = MagicMock()
    fake_request.app.state.run_svc._client = fake_client

    resp = await proxy_artifact("sim-1", "missing", fake_request)
    assert resp.status_code == 404
    async for _ in resp.body_iterator:
        pass


# ── bff/api/streams.py — WS proxy unauthorized branch ──────────────────────

@pytest.mark.asyncio
async def test_streams_proxy_log_rejects_invalid_token(monkeypatch):
    """The unauthorized branch closes the WS with code 4001 (WS_UNAUTHORIZED)
    before any upstream connection is attempted."""
    from app.api import streams

    fake_ws = AsyncMock()
    monkeypatch.setattr(streams, "verify_ws_token", AsyncMock(return_value=False))
    await streams.proxy_log(fake_ws, "sim-1")
    fake_ws.close.assert_awaited_once()
    args, kwargs = fake_ws.close.call_args
    # WS_UNAUTHORIZED is the 4001 application-level close code.
    assert kwargs.get("code") or args[0] == streams.WS_UNAUTHORIZED


@pytest.mark.asyncio
async def test_streams_proxy_log_handles_upstream_failure(monkeypatch):
    """When the upstream connect raises, the proxy closes the client WS with
    code 1011 + the truncated reason."""
    from app.api import streams

    fake_ws = AsyncMock()
    fake_ws.app.state.run_svc.base_url = "http://run-svc:8081"
    monkeypatch.setattr(streams, "verify_ws_token", AsyncMock(return_value=True))

    # Make websockets.connect throw — simulates network error on upstream.
    async def _bad_connect(url):
        raise OSError("upstream unreachable")

    class _BadConnectCtx:
        def __init__(self, *a, **kw):
            self.exc = a[0] if a else None
        async def __aenter__(self):
            raise OSError("upstream unreachable")
        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(streams.websockets, "connect", lambda *a, **kw: _BadConnectCtx())
    await streams.proxy_log(fake_ws, "sim-1")
    fake_ws.accept.assert_awaited_once()
    fake_ws.close.assert_awaited()
    # The close call should carry code 1011 (server error).
    closed_args = fake_ws.close.call_args
    assert closed_args.kwargs.get("code") == 1011 or \
        (closed_args.args and closed_args.args[0] == 1011)
