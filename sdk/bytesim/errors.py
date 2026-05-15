"""Typed errors. Kept tiny so callers can write narrow except blocks."""
from __future__ import annotations


class ApiError(Exception):
    """Any non-2xx response. Carries status + body for diagnostics."""

    def __init__(self, status: int, body: str, *, path: str = ""):
        super().__init__(f"{status} @ {path}: {body[:200]}")
        self.status = status
        self.body = body
        self.path = path


class AuthError(ApiError):
    """401 / 403 — user is not logged in, token expired, or actor cannot
    access the requested project. CLI catches this to print a short hint."""


class NotFoundError(ApiError):
    """404 — the requested resource does not exist."""
