from __future__ import annotations

import asyncio

import websockets
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.auth import WS_UNAUTHORIZED, verify_ws_token

router = APIRouter()


@router.websocket("/v1/streams/run/{run_id}/log")
async def proxy_log(ws: WebSocket, run_id: str) -> None:
    """Proxy WS to run-svc so the browser only knows about the BFF origin."""
    if not await verify_ws_token(ws):
        await ws.close(code=WS_UNAUTHORIZED)
        return
    await ws.accept()
    base = ws.app.state.run_svc.base_url.replace("http://", "ws://").replace("https://", "wss://")
    upstream_url = f"{base}/v1/streams/run/{run_id}/log"
    try:
        async with websockets.connect(upstream_url) as upstream:
            async def upstream_to_client() -> None:
                async for msg in upstream:
                    await ws.send_text(msg if isinstance(msg, str) else msg.decode())

            async def client_to_upstream() -> None:
                while True:
                    data = await ws.receive_text()
                    await upstream.send(data)

            await asyncio.gather(upstream_to_client(), client_to_upstream(), return_exceptions=True)
    except WebSocketDisconnect:
        return
    except Exception as exc:
        await ws.close(code=1011, reason=str(exc)[:120])
