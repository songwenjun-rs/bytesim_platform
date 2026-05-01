"""engine-svc top-level (slice-12 concurrent).

N async workers race on `POST /v1/runs/claim` to atomically pull queued Runs.
A separate cancel-watcher subscribes to bs.events for `run.cancelled` records
and signals the pipeline so the in-flight stage finishes its current step then
bails out at the next stage boundary.

Scaling further: deploy multiple engine-svc replicas pointing at the same
run-svc — the SQL-level `FOR UPDATE SKIP LOCKED` already coordinates between
them, no leader election needed."""
from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager

from aiokafka import AIOKafkaConsumer
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app._obs import (
    PrometheusMiddleware,
    TraceIdMiddleware,
    mount_metrics,
    setup_logging,
)
from app.clients import Backends
from app.event_bus import EventBus
from app.pipeline import Pipeline


POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL_S", "2.0"))
WORKERS = int(os.environ.get("ENGINE_WORKERS", "3"))
KAFKA_BOOTSTRAP = os.environ.get("KAFKA_BOOTSTRAP", "localhost:19092")

setup_logging("engine-svc")
log = logging.getLogger("engine.main")


async def worker_loop(app: FastAPI, worker_id: int) -> None:
    pipeline: Pipeline = app.state.pipeline
    backends: Backends = app.state.backends
    log.info("worker %d started · poll every %ss", worker_id, POLL_INTERVAL)
    while True:
        try:
            run = await backends.claim_next()
        except asyncio.CancelledError:
            return
        except Exception as exc:
            log.warning("worker %d claim failed: %s", worker_id, exc)
            await asyncio.sleep(POLL_INTERVAL * 2)
            continue

        if run is None:
            await asyncio.sleep(POLL_INTERVAL)
            continue

        log.info("worker %d picked %s", worker_id, run["id"])
        try:
            await pipeline.execute(run["id"])
        except asyncio.CancelledError:
            return
        except Exception as exc:
            log.exception("worker %d pipeline crashed for %s: %s", worker_id, run["id"], exc)


async def cancel_watcher(app: FastAPI) -> None:
    """Subscribe to bs.events; when run-svc /cancel ran, propagate to pipeline."""
    consumer = AIOKafkaConsumer(
        "bs.events",
        bootstrap_servers=KAFKA_BOOTSTRAP,
        client_id="engine-svc-cancel",
        group_id=None,                       # broadcast — every replica reacts
        auto_offset_reset="latest",
        value_deserializer=lambda v: json.loads(v.decode()),
    )
    await consumer.start()
    log.info("cancel watcher subscribed @ %s", KAFKA_BOOTSTRAP)
    try:
        async for record in consumer:
            ev = record.value
            if ev.get("kind") == "run.cancelled" and ev.get("run_id"):
                log.info("cancel signal received for %s", ev["run_id"])
                app.state.pipeline.cancel(ev["run_id"])
    except asyncio.CancelledError:
        return
    finally:
        await consumer.stop()


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.backends = Backends()
    app.state.bus = EventBus()
    await app.state.bus.start()
    app.state.pipeline = Pipeline(app.state.backends, app.state.bus)
    app.state.workers = [asyncio.create_task(worker_loop(app, i)) for i in range(WORKERS)]
    app.state.cancel_watcher = asyncio.create_task(cancel_watcher(app))
    log.info("engine-svc ready · %d workers · cancel watcher on", WORKERS)
    try:
        yield
    finally:
        for t in app.state.workers + [app.state.cancel_watcher]:
            t.cancel()
        for t in app.state.workers + [app.state.cancel_watcher]:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        await app.state.bus.stop()
        await app.state.backends.close()


app = FastAPI(title="ByteSim Engine", version="0.2.0", lifespan=lifespan)
app.add_middleware(TraceIdMiddleware)
app.add_middleware(PrometheusMiddleware, service="engine-svc")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
mount_metrics(app)


@app.get("/healthz")
def healthz() -> dict[str, str | int]:
    return {"status": "ok", "workers": WORKERS}


@app.post("/v1/engine/kick/{run_id}")
async def kick(run_id: str) -> dict[str, str]:
    """Acknowledge a kick from BFF. The poll-loop workers (each polling every
    POLL_INTERVAL_S seconds via /v1/runs/claim) are the SOURCE OF TRUTH for
    Run execution — they're the only path that goes through the atomic SQL
    claim. The previous implementation spawned `pipeline.execute()` here too,
    which raced with the polling worker and produced double-executions on the
    same run. We just acknowledge now; the worker picks the run up within
    POLL_INTERVAL_S seconds anyway."""
    return {"acknowledged": run_id}
