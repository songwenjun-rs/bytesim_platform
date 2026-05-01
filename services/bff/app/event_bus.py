"""Kafka consumer + producer for the bs.events topic.

Consumer (slice-9): drives the dashboard WS fan-out — every record received
is forwarded to all open dashboard streams.

Producer (slice-12): used by cancel — when BFF receives a /cancel request, it
broadcasts `run.cancelled` so engine-svc workers can signal the in-flight
pipeline to bail out at the next stage boundary."""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

from aiokafka import AIOKafkaConsumer, AIOKafkaProducer

log = logging.getLogger("bff.event_bus")
TOPIC = "bs.events"


class EventBus:
    def __init__(self) -> None:
        self.bootstrap = os.environ.get("KAFKA_BOOTSTRAP", "localhost:19092")
        self._consumer: AIOKafkaConsumer | None = None
        self._producer: AIOKafkaProducer | None = None
        self._task: asyncio.Task | None = None
        self.subscribers: list[asyncio.Queue[dict[str, Any]]] = []

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=128)
        self.subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        try:
            self.subscribers.remove(q)
        except ValueError:
            pass

    async def open(self) -> None:
        self._consumer = AIOKafkaConsumer(
            TOPIC,
            bootstrap_servers=self.bootstrap,
            client_id="bff",
            group_id="bff",
            auto_offset_reset="latest",
            value_deserializer=lambda v: json.loads(v.decode()),
            enable_auto_commit=True,
        )
        await self._consumer.start()
        self._producer = AIOKafkaProducer(
            bootstrap_servers=self.bootstrap,
            value_serializer=lambda v: json.dumps(v).encode(),
            key_serializer=lambda k: (k or "").encode(),
            client_id="bff",
        )
        await self._producer.start()
        self._task = asyncio.create_task(self._loop())
        log.info("kafka producer + consumer ready @ %s · topic %s", self.bootstrap, TOPIC)

    async def close(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        if self._consumer:
            await self._consumer.stop()
            self._consumer = None
        if self._producer:
            await self._producer.stop()
            self._producer = None

    async def publish(self, event: dict[str, Any]) -> None:
        if self._producer is None:
            return
        try:
            await self._producer.send_and_wait(
                TOPIC, value=event,
                key=event.get("run_id") or event.get("kind") or "bff",
            )
        except Exception as exc:
            log.warning("publish failed (%s): %s", event.get("kind"), exc)

    async def _loop(self) -> None:
        assert self._consumer
        try:
            async for record in self._consumer:
                event = record.value
                log.info("event received: %s", event.get("kind"))
                for q in list(self.subscribers):
                    try:
                        q.put_nowait(event)
                    except asyncio.QueueFull:
                        pass
        except asyncio.CancelledError:
            return
        except Exception as exc:
            log.exception("consumer loop crashed: %s", exc)
