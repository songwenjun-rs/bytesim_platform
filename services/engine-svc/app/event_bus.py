"""Kafka producer for engine-svc lifecycle events. Emits run.started /
run.progress / run.completed / run.failed onto the bs.events topic so the
dashboard (via BFF) gets push updates."""
from __future__ import annotations

import json
import logging
import os
from typing import Any

from aiokafka import AIOKafkaProducer

log = logging.getLogger("engine.event_bus")
TOPIC = "bs.events"


class EventBus:
    def __init__(self) -> None:
        self.bootstrap = os.environ.get("KAFKA_BOOTSTRAP", "localhost:19092")
        self._producer: AIOKafkaProducer | None = None

    async def start(self) -> None:
        self._producer = AIOKafkaProducer(
            bootstrap_servers=self.bootstrap,
            value_serializer=lambda v: json.dumps(v).encode(),
            key_serializer=lambda k: (k or "").encode(),
            client_id="engine-svc",
        )
        await self._producer.start()
        log.info("kafka producer ready @ %s", self.bootstrap)

    async def stop(self) -> None:
        if self._producer:
            await self._producer.stop()
            self._producer = None

    async def publish(self, event: dict[str, Any]) -> None:
        if self._producer is None:
            return
        try:
            await self._producer.send_and_wait(
                TOPIC, value=event, key=event.get("run_id") or event.get("kind") or "engine",
            )
        except Exception as exc:
            log.warning("kafka publish failed (%s): %s", event.get("kind"), exc)
