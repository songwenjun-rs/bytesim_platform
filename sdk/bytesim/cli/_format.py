"""Tiny output helpers — table for human, json for scripts.

No third-party deps so the SDK stays light. Tables align by column max
width; long cells are truncated unless --wide. Colors are TTY-only so
piping into less / jq stays clean."""
from __future__ import annotations

import json
import sys
from typing import Any, Iterable, Sequence


_USE_COLOR = sys.stdout.isatty()


def _c(s: str, color: str) -> str:
    if not _USE_COLOR:
        return s
    codes = {
        "dim": "\033[2m", "bold": "\033[1m",
        "red": "\033[31m", "green": "\033[32m", "yellow": "\033[33m",
        "blue": "\033[34m", "cyan": "\033[36m",
    }
    return f"{codes.get(color, '')}{s}\033[0m"


def emit(data: Any, *, fmt: str = "table", columns: Sequence[str] | None = None,
         max_width: int = 50) -> None:
    """Print `data` as table (default) or JSON."""
    if fmt == "json":
        print(json.dumps(data, ensure_ascii=False, indent=2, default=str))
        return
    if data is None:
        return
    if isinstance(data, list):
        _print_table(data, columns=columns, max_width=max_width)
    elif isinstance(data, dict):
        _print_kv(data, max_width=max_width)
    else:
        print(str(data))


def _print_table(rows: list[Any], *, columns: Sequence[str] | None, max_width: int) -> None:
    if not rows:
        print(_c("(空)", "dim"))
        return
    if not isinstance(rows[0], dict):
        for r in rows:
            print(str(r))
        return
    cols = list(columns) if columns else list(rows[0].keys())
    widths = {c: max(len(c), *(len(_cellstr(r.get(c), max_width)) for r in rows)) for c in cols}

    header = "  ".join(_c(c.ljust(widths[c]), "bold") for c in cols)
    sep = "  ".join("─" * widths[c] for c in cols)
    print(header)
    print(_c(sep, "dim"))
    for r in rows:
        line = "  ".join(_cellstr(r.get(c), max_width).ljust(widths[c]) for c in cols)
        print(_colorize_status_inline(line, r))


def _print_kv(d: dict, *, max_width: int) -> None:
    if not d:
        print(_c("(空)", "dim"))
        return
    klen = max(len(str(k)) for k in d.keys())
    for k, v in d.items():
        if isinstance(v, (dict, list)):
            v = json.dumps(v, ensure_ascii=False, default=str)
        s = _cellstr(v, max_width * 2)
        print(f"{_c(str(k).ljust(klen), 'cyan')}  {s}")


def _cellstr(v: Any, max_width: int) -> str:
    if v is None:
        return ""
    s = str(v) if not isinstance(v, (dict, list)) else json.dumps(v, ensure_ascii=False, default=str)
    if len(s) > max_width:
        return s[:max_width - 1] + "…"
    return s


def _colorize_status_inline(line: str, row: dict) -> str:
    """If the row has a `status` field, color the whole line accordingly."""
    s = (row.get("status") or "").lower() if isinstance(row, dict) else ""
    if s in ("failed", "rejected", "err"):
        return _c(line, "red")
    if s in ("done", "ok", "completed"):
        return _c(line, "green")
    if s in ("running", "queued", "pending_confirm"):
        return _c(line, "yellow")
    return line


def err(msg: str) -> None:
    print(_c(f"× {msg}", "red"), file=sys.stderr)


def info(msg: str) -> None:
    print(_c(f"✓ {msg}", "green"), file=sys.stderr)


def warn(msg: str) -> None:
    print(_c(f"! {msg}", "yellow"), file=sys.stderr)
