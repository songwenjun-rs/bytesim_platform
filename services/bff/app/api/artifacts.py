from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

router = APIRouter()


@router.get("/v1/artifacts/{run_id}/{name}")
async def proxy_artifact(run_id: str, name: str, request: Request) -> StreamingResponse:
    """Stream-passthrough to run-svc; keeps run-svc off the public origin."""
    client = request.app.state.run_svc._client  # type: ignore[attr-defined]
    upstream = await client.send(
        client.build_request("GET", f"/v1/artifacts/{run_id}/{name}"),
        stream=True,
    )

    async def gen():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()

    headers = {}
    if "content-length" in upstream.headers:
        headers["content-length"] = upstream.headers["content-length"]
    return StreamingResponse(
        gen(),
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type", "application/octet-stream"),
        headers=headers,
    )
