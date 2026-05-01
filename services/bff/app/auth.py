"""Slice-15: minimum-viable auth.

JWT (HS256) hand-rolled with stdlib so we don't take on PyJWT for this slice.
The middleware:

* lets a small allow-list pass without a token (login, healthz, root WS handshake
  is upgraded after the HTTP path is checked, so we cover those too)
* otherwise demands `Authorization: Bearer <jwt>` and parses an `X-Project-ID`
  header — defaulting to the first project in the token's claim list
* writes `actor_id`, `project_id`, `projects` onto `request.state` so handlers
  can read them via `request.state.project_id`

The "password" check in `/v1/auth/login` is intentionally a no-op (any non-empty
user-id mints a token) — this slice is about plumbing actor + project context
through every layer, not about real auth. Production would swap this for OIDC
or a real IdP behind the same middleware contract.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any

from fastapi import Request, WebSocket
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

_DEFAULT_DEV_JWT_SECRET = "dev-secret-do-not-ship"
JWT_SECRET = os.environ.get("BFF_JWT_SECRET") or _DEFAULT_DEV_JWT_SECRET
JWT_TTL_SECONDS = int(os.environ.get("BFF_JWT_TTL", str(8 * 3600)))


def assert_secret_configured() -> None:
    """Call from BFF lifespan startup. Refuses to boot with the dev fallback
    secret unless BFF_ALLOW_DEV_SECRET=1 is set explicitly (compose/dev does
    set it; production must not). Test code imports this module without
    calling this function, so unit tests run with the fallback unaffected."""
    if JWT_SECRET == _DEFAULT_DEV_JWT_SECRET and os.environ.get("BFF_ALLOW_DEV_SECRET") != "1":
        raise RuntimeError(
            "BFF_JWT_SECRET is required. Set BFF_JWT_SECRET to a strong value, "
            "or export BFF_ALLOW_DEV_SECRET=1 to opt into the dev default (insecure)."
        )

# Demo user → projects mapping. Real IdP would source this from a directory.
USER_PROJECTS: dict[str, list[str]] = {
    "songwenjun": ["p_default", "p_lab"],
    "lihaoran":   ["p_default", "p_lab"],
    "zhangmo":    ["p_default"],
    "alice":      ["p_lab"],  # single-project user — proves the gate works
}

# §7: simple role map. data_steward gates production-snapshot approval.
# Default = analyst. Real IdP would source roles from group membership.
USER_ROLES: dict[str, str] = {
    "songwenjun": "admin",         # platform owner
    "lihaoran":   "data_steward",  # owns approval of production snapshots
    "zhangmo":    "analyst",
    "alice":      "viewer",
}
DEFAULT_ROLE = "analyst"

# Paths that bypass HTTP auth. Must include the login endpoint and healthz.
# Note: WebSocket upgrades bypass BaseHTTPMiddleware regardless — WS auth is
# enforced per-handler via verify_ws_token() below, not via this list.
PUBLIC_PATHS = {"/healthz", "/metrics", "/v1/auth/login", "/v1/auth/users"}
PUBLIC_PREFIXES: tuple[str, ...] = ()

# WebSocket close code for unauthenticated connections. 4xxx is the
# application-defined range in RFC 6455; 4401 mirrors HTTP 401.
WS_UNAUTHORIZED = 4401


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def mint_token(actor_id: str, projects: list[str], role: str | None = None) -> str:
    """Mint JWT. role defaults to USER_ROLES lookup so old call sites get the
    right role automatically — but new call sites can pass it explicitly."""
    if role is None:
        role = USER_ROLES.get(actor_id, DEFAULT_ROLE)
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "sub": actor_id,
        "projects": projects,
        "role": role,
        "iat": int(time.time()),
        "exp": int(time.time()) + JWT_TTL_SECONDS,
    }
    h = _b64url(json.dumps(header, separators=(",", ":")).encode())
    p = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(JWT_SECRET.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest()
    return f"{h}.{p}.{_b64url(sig)}"


def verify_token(token: str) -> dict[str, Any] | None:
    try:
        h, p, s = token.split(".")
    except ValueError:
        return None
    expected_sig = _b64url(
        hmac.new(JWT_SECRET.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest()
    )
    if not hmac.compare_digest(expected_sig, s):
        return None
    try:
        payload = json.loads(_b64url_decode(p))
    except Exception:
        return None
    if int(payload.get("exp", 0)) < int(time.time()):
        return None
    return payload


def authenticate_user(user_id: str, _password: str) -> list[str] | None:
    """Slice-15 fake login: any registered user_id passes; password is ignored.
    Returns the project list the token should be scoped to, or None if the
    user is unknown."""
    user_id = (user_id or "").strip().lower()
    return USER_PROJECTS.get(user_id)


async def verify_ws_token(ws: WebSocket) -> dict[str, Any] | None:
    """Authenticate a WebSocket upgrade. Returns the JWT claim on success or
    None when the caller must reject the connection.

    Reads:
      * `?token=<jwt>` from query string (browsers can't set Authorization on WS)
      * `?project_id=<id>` (optional; falls back to first project in the claim)

    On success, stashes actor / project / role onto `ws.scope` so handlers
    can read them for upstream provenance. (WebSocket has no `state` like
    Request — scope is the equivalent attachment surface.)
    """
    token = ws.query_params.get("token", "")
    claim = verify_token(token) if token else None
    if not claim:
        return None
    projects: list[str] = list(claim.get("projects") or [])
    actor_id: str = claim.get("sub") or "?"
    requested = ws.query_params.get("project_id")
    project_id = requested or (projects[0] if projects else "")
    if not project_id or project_id not in projects:
        return None
    ws.scope["actor_id"] = actor_id
    ws.scope["project_id"] = project_id
    ws.scope["projects"] = projects
    ws.scope["role"] = claim.get("role") or USER_ROLES.get(actor_id, DEFAULT_ROLE)
    return claim


class AuthMiddleware(BaseHTTPMiddleware):
    """Read JWT from Authorization, X-Project-ID from header (or default to
    first project in claim). Stash on request.state. Responses are 401 on
    missing/invalid token, 403 on cross-project access."""

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if path in PUBLIC_PATHS or path.startswith(PUBLIC_PREFIXES):
            return await call_next(request)

        auth_header = request.headers.get("authorization", "")
        token = auth_header[7:].strip() if auth_header.lower().startswith("bearer ") else ""
        if not token:
            # Allow ?token= as a fallback for SSE/EventSource (which can't set headers).
            token = request.query_params.get("token", "")
        claim = verify_token(token) if token else None
        if not claim:
            return JSONResponse({"detail": "missing or invalid token"}, status_code=401)

        projects: list[str] = list(claim.get("projects") or [])
        actor_id: str = claim.get("sub") or "?"
        requested = request.headers.get("x-project-id") or request.query_params.get("project_id")
        project_id = requested or (projects[0] if projects else "")
        if not project_id:
            return JSONResponse({"detail": "no project bound to token"}, status_code=403)
        if project_id not in projects:
            return JSONResponse(
                {"detail": f"actor {actor_id} cannot access project {project_id}"},
                status_code=403,
            )

        request.state.actor_id = actor_id
        request.state.project_id = project_id
        request.state.projects = projects
        # §7: role for downstream RBAC checks (e.g. snapshot approval).
        # Tokens minted before §7 don't carry `role` — fall back to USER_ROLES
        # lookup or DEFAULT_ROLE so existing tokens stay usable.
        request.state.role = (
            claim.get("role")
            or USER_ROLES.get(actor_id, DEFAULT_ROLE)
        )
        return await call_next(request)
