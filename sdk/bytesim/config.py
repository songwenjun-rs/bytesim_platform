"""Persistent client config.

Defaults to ``~/.bytesim/config.toml`` but every field can be overridden by
an environment variable so CI / containers can stay 12-factor:

    BYTESIM_BASE_URL  → base_url
    BYTESIM_TOKEN     → token
    BYTESIM_PROJECT   → project
    BYTESIM_ACTOR     → actor_id (cosmetic; real identity comes from token)

Env wins over file so users can scope a single shell to a different cluster
without rewriting the file.
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover — we declare 3.11 in pyproject
    import tomli as tomllib  # type: ignore

DEFAULT_PATH = Path.home() / ".bytesim" / "config.toml"
DEFAULT_BASE_URL = "http://localhost:8080"


@dataclass
class Config:
    base_url: str = DEFAULT_BASE_URL
    token: str | None = None
    project: str | None = None
    actor_id: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def with_overrides(self) -> "Config":
        """Return a copy with env-var overrides applied."""
        return Config(
            base_url=os.environ.get("BYTESIM_BASE_URL", self.base_url),
            token=os.environ.get("BYTESIM_TOKEN", self.token),
            project=os.environ.get("BYTESIM_PROJECT", self.project),
            actor_id=os.environ.get("BYTESIM_ACTOR", self.actor_id),
            extra=dict(self.extra),
        )


def load_config(path: Path | None = None) -> Config:
    """Read the config file (or return defaults if missing) and apply env."""
    p = path or DEFAULT_PATH
    if not p.exists():
        return Config().with_overrides()
    raw = tomllib.loads(p.read_text())
    return Config(
        base_url=raw.get("base_url", DEFAULT_BASE_URL),
        token=raw.get("token"),
        project=raw.get("project"),
        actor_id=raw.get("actor_id"),
        extra={k: v for k, v in raw.items()
               if k not in {"base_url", "token", "project", "actor_id"}},
    ).with_overrides()


def save_config(cfg: Config, path: Path | None = None) -> Path:
    """Persist the config minus env-only overrides. Creates parent dir."""
    p = path or DEFAULT_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    body = _to_toml({
        "base_url": cfg.base_url,
        **({"token": cfg.token} if cfg.token else {}),
        **({"project": cfg.project} if cfg.project else {}),
        **({"actor_id": cfg.actor_id} if cfg.actor_id else {}),
        **cfg.extra,
    })
    p.write_text(body)
    try:
        p.chmod(0o600)  # token is sensitive — best-effort restrict
    except OSError:
        pass
    return p


def _to_toml(d: dict[str, Any]) -> str:
    """Tiny TOML emitter for our flat config; avoids a write-side dep."""
    out = []
    for k, v in d.items():
        if isinstance(v, str):
            out.append(f'{k} = "{_escape(v)}"')
        elif isinstance(v, bool):
            out.append(f"{k} = {str(v).lower()}")
        elif isinstance(v, (int, float)):
            out.append(f"{k} = {v}")
        else:
            # nested objects flattened to JSON-as-string — uncommon here
            import json
            out.append(f'{k} = "{_escape(json.dumps(v))}"')
    return "\n".join(out) + "\n"


def _escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')
