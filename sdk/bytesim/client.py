"""ByteSim client.

Thin wrapper around an httpx.Client that:
* injects Authorization + X-Project-ID on every request
* maps HTTP errors to typed exceptions (Auth/NotFound/Api)
* exposes resource namespaces — `client.runs`, `client.specs`, etc.

Sync-only by default. Notebook + script users vastly outnumber async users
on this platform; async wrappers can come later if needed.
"""
from __future__ import annotations

from typing import Any, Iterator

import httpx

from .config import Config, load_config
from .errors import ApiError, AuthError, NotFoundError


class Client:
    def __init__(
        self,
        *,
        config: Config | None = None,
        base_url: str | None = None,
        token: str | None = None,
        project: str | None = None,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 30.0,
    ) -> None:
        cfg = config or load_config()
        self.base_url = base_url or cfg.base_url
        self.token = token if token is not None else cfg.token
        self.project = project if project is not None else cfg.project
        self.actor_id = cfg.actor_id
        self._http = httpx.Client(
            base_url=self.base_url,
            transport=transport,
            timeout=timeout,
        )
        # Lazy resource namespaces — imported here to avoid cycles.
        from .resources.runs import Runs
        from .resources.specs import Specs
        self.runs = Runs(self)
        self.specs = Specs(self)

    # ── identity helpers ────────────────────────────────────────────────
    def use_project(self, project: str) -> None:
        """Switch active project. Subsequent requests carry the new header."""
        self.project = project

    def whoami(self) -> dict[str, Any]:
        return self.get("/v1/auth/me")

    # ── HTTP plumbing ──────────────────────────────────────────────────
    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        h: dict[str, str] = {}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        if self.project:
            h["X-Project-ID"] = self.project
        if extra:
            h.update(extra)
        return h

    def request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        r = self._http.request(
            method, path, json=json, params=params, headers=self._headers(headers)
        )
        if r.status_code == 401:
            raise AuthError(401, r.text, path=path)
        if r.status_code == 403:
            raise AuthError(403, r.text, path=path)
        if r.status_code == 404:
            raise NotFoundError(404, r.text, path=path)
        if r.status_code >= 400:
            raise ApiError(r.status_code, r.text, path=path)
        return r

    def get(self, path: str, *, params: dict[str, Any] | None = None) -> Any:
        return self.request("GET", path, params=params).json()

    def post(self, path: str, body: Any = None) -> Any:
        return self.request("POST", path, json=body).json()

    def delete(self, path: str) -> Any:
        return self.request("DELETE", path).json()

    def stream_lines(
        self, method: str, path: str, *, json: Any = None,
    ) -> Iterator[str]:
        """Stream a text/event-stream or NDJSON response line-by-line.
        Used by `runs.tail()` for engine.log streaming."""
        with self._http.stream(method, path, json=json, headers=self._headers()) as r:
            if r.status_code >= 400:
                # Drain so we can include body in the error
                body = r.read().decode(errors="replace")
                if r.status_code in (401, 403):
                    raise AuthError(r.status_code, body, path=path)
                raise ApiError(r.status_code, body, path=path)
            for line in r.iter_lines():
                if line:
                    yield line

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
