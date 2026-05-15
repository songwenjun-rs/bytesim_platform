"""Standalone login helper used by both `bytesim login` CLI and notebooks.

Login is the only path that *creates* a token rather than consuming one, so
it lives outside the Client (which assumes you already have credentials)."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx

from .config import Config, DEFAULT_BASE_URL, load_config, save_config
from .errors import ApiError, AuthError


def login(
    user_id: str,
    *,
    password: str = "",
    base_url: str | None = None,
    project: str | None = None,
    config_path: Path | None = None,
    save: bool = True,
    transport: httpx.BaseTransport | None = None,
) -> Config:
    """POST /v1/auth/login, persist token+project to ~/.bytesim/config.toml.

    `password` is unused by the slice-15 fake-auth backend, but kept in the
    signature so a future real IdP swap doesn't change the public API."""
    cfg = load_config(config_path)
    base = base_url or cfg.base_url or DEFAULT_BASE_URL

    with httpx.Client(base_url=base, transport=transport, timeout=30.0) as h:
        r = h.post("/v1/auth/login", json={"user_id": user_id, "password": password})
    if r.status_code == 401:
        raise AuthError(401, r.text, path="/v1/auth/login")
    if r.status_code >= 400:
        raise ApiError(r.status_code, r.text, path="/v1/auth/login")

    data = r.json()
    projects = data.get("projects") or []
    chosen = project or (cfg.project if cfg.project in projects else None) or (projects[0] if projects else None)

    new_cfg = Config(
        base_url=base,
        token=data["token"],
        project=chosen,
        actor_id=data.get("actor_id") or user_id,
        extra=cfg.extra,
    )
    if save:
        save_config(new_cfg, config_path)
    return new_cfg


def logout(config_path: Path | None = None) -> None:
    """Drop token + project from on-disk config but keep base_url so the
    next `bytesim login` doesn't need --base-url again."""
    cfg = load_config(config_path)
    cfg.token = None
    # keep project as a hint for next login
    save_config(cfg, config_path)
