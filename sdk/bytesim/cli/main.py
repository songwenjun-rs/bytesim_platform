"""ByteSim CLI entry point.

Pure stdlib argparse, one subparser per resource. Every command takes
`--json` to switch to machine-readable output and inherits `--base-url`,
`--project`, `--token` for one-shot overrides without touching the config
file.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Sequence

from .. import __version__
from ..auth import login as do_login, logout as do_logout
from ..client import Client
from ..config import load_config, save_config
from ..errors import ApiError, AuthError, NotFoundError
from . import _format as fmt


# ── command implementations ──────────────────────────────────────────────

def cmd_login(args, _cfg) -> int:
    pwd = args.password or os.environ.get("BYTESIM_PASSWORD", "")
    cfg = do_login(
        args.user_id, password=pwd,
        base_url=args.base_url, project=args.project,
    )
    fmt.info(f"已登录为 {cfg.actor_id} · 项目 {cfg.project} · base {cfg.base_url}")
    return 0


def cmd_logout(_args, _cfg) -> int:
    do_logout()
    fmt.info("已清除本地 token")
    return 0


def cmd_whoami(args, cfg) -> int:
    if not cfg.token:
        fmt.err("未登录。运行 `bytesim login <user_id>`")
        return 1
    with _client(args, cfg) as c:
        me = c.whoami()
    fmt.emit(me, fmt=args.format)
    return 0


def cmd_config_show(args, cfg) -> int:
    fmt.emit({
        "base_url": cfg.base_url,
        "project": cfg.project,
        "actor_id": cfg.actor_id,
        "token": (cfg.token[:12] + "…") if cfg.token else None,
    }, fmt=args.format)
    return 0


def cmd_project_list(args, cfg) -> int:
    with _client(args, cfg) as c:
        me = c.whoami()
    rows = [{"project_id": p, "active": (p == me.get("project_id"))} for p in me.get("projects", [])]
    fmt.emit(rows, fmt=args.format, columns=["project_id", "active"])
    return 0


def cmd_project_switch(args, cfg) -> int:
    cfg.project = args.project_id
    save_config(cfg)
    fmt.info(f"已切到项目 {args.project_id}")
    return 0


# ── runs ─────────────────────────────────────────────────────────────────

def cmd_run_list(args, cfg) -> int:
    with _client(args, cfg) as c:
        rows = c.runs.list(status=args.status, kind=args.kind, limit=args.limit)
    fmt.emit(rows, fmt=args.format,
             columns=["id", "kind", "title", "status", "progress_pct", "confidence", "created_by"])
    return 0


def cmd_run_get(args, cfg) -> int:
    with _client(args, cfg) as c:
        data = c.runs.get_full(args.run_id) if args.full else c.runs.get(args.run_id)
    fmt.emit(data, fmt=args.format)
    return 0


def cmd_run_create(args, cfg) -> int:
    body: dict[str, Any] = {}
    if args.from_file:
        body = json.loads(Path(args.from_file).read_text())
    if args.hwspec_hash: body["hwspec_hash"] = args.hwspec_hash
    if args.model_hash: body["model_hash"] = args.model_hash
    if args.strategy_hash: body["strategy_hash"] = args.strategy_hash
    if args.workload_hash: body["workload_hash"] = args.workload_hash
    if args.title: body["title"] = args.title
    if args.kind: body["kind"] = args.kind
    if "hwspec_hash" not in body or "model_hash" not in body:
        fmt.err("--hwspec-hash 与 --model-hash 必填（或 --from-file 提供）")
        return 2
    with _client(args, cfg) as c:
        created = c.runs.create(**body)
    fmt.info(f"已创建 Run {created['id']} · status {created.get('status')}")
    fmt.emit(created, fmt=args.format)
    return 0


def cmd_run_cancel(args, cfg) -> int:
    with _client(args, cfg) as c:
        out = c.runs.cancel(args.run_id)
    if out.get("was_running"):
        fmt.info(f"已取消运行中的 Run {args.run_id} · Kafka 已广播")
    else:
        fmt.info(f"已取消 queued Run {args.run_id}")
    return 0


def cmd_run_kick(args, cfg) -> int:
    with _client(args, cfg) as c:
        c.runs.kick(args.run_id)
    fmt.info(f"已唤醒 engine-svc 处理 {args.run_id}")
    return 0


def cmd_run_tail(args, cfg) -> int:
    with _client(args, cfg) as c:
        try:
            for line in c.runs.tail(args.run_id):
                print(line)
        except KeyboardInterrupt:
            return 130
    return 0


# ── specs ────────────────────────────────────────────────────────────────

def cmd_spec_get(args, cfg) -> int:
    with _client(args, cfg) as c:
        data = c.specs.get(args.kind, args.spec_id)
    fmt.emit(data, fmt=args.format)
    return 0


def cmd_spec_versions(args, cfg) -> int:
    with _client(args, cfg) as c:
        rows = c.specs.versions(args.kind, args.spec_id)
    fmt.emit(rows, fmt=args.format, columns=["version_tag", "hash", "parent_hash", "created_at"])
    return 0


def cmd_spec_diff(args, cfg) -> int:
    with _client(args, cfg) as c:
        data = c.specs.diff(args.kind, args.spec_id, args.from_hash, args.to_hash)
    if args.format == "json":
        fmt.emit(data, fmt="json")
        return 0
    entries = data.get("entries", [])
    if not entries:
        fmt.info("两个版本结构相同")
        return 0
    rows = [{"op": e["op"], "path": e["path"], "from": e.get("from"), "to": e.get("to")} for e in entries]
    fmt.emit(rows, fmt="table", columns=["op", "path", "from", "to"])
    return 0


def cmd_spec_fork(args, cfg) -> int:
    with _client(args, cfg) as c:
        out = c.specs.fork(args.kind, args.spec_id, new_name=args.new_name, from_hash=args.from_hash)
    fmt.info(f"已派生为 {out['spec']['id']} · {out['version']['version_tag']}")
    fmt.emit(out, fmt=args.format)
    return 0


def cmd_spec_snapshot(args, cfg) -> int:
    body = json.loads(Path(args.from_file).read_text())
    with _client(args, cfg) as c:
        out = c.specs.snapshot(args.kind, args.spec_id, body=body, version_tag=args.tag)
    fmt.info(f"已快照为 {out.get('version_tag')} · hash {out['hash'][:8]}…")
    fmt.emit(out, fmt=args.format)
    return 0


# ── helpers ──────────────────────────────────────────────────────────────

def _client(args, cfg) -> Client:
    """Build a Client from config + per-invocation overrides."""
    return Client(
        config=cfg,
        base_url=args.base_url or cfg.base_url,
        token=args.token or cfg.token,
        project=args.project or cfg.project,
    )


# ── argparse wiring ──────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    # Shared flags so users can put --base-url / --project / --format
    # before *or* after the subcommand. Subparsers inherit via `parents=`.
    shared = argparse.ArgumentParser(add_help=False)
    shared.add_argument("--base-url", help="Override BFF base URL for this invocation")
    shared.add_argument("--token", help="Override JWT token for this invocation")
    shared.add_argument("--project", help="Override active project for this invocation")
    shared.add_argument("--format", choices=("table", "json"), default="table",
                        help="Output format (default: table)")

    p = argparse.ArgumentParser(prog="bytesim", description="ByteSim platform CLI", parents=[shared])
    p.add_argument("--version", action="version", version=__version__)
    sub = p.add_subparsers(dest="cmd", required=True)
    # Local helper so every add_parser call inherits the shared flags.
    def _sub(name: str, **kw):
        return sub.add_parser(name, parents=[shared], **kw)

    # login / logout / whoami / config / project
    s = _sub("login", help="登录")
    s.add_argument("user_id")
    s.add_argument("--password", default="", help="（slice-15 demo 后端忽略，但保留参数）")
    s.set_defaults(func=cmd_login)

    s = _sub("logout", help="清除本地 token")
    s.set_defaults(func=cmd_logout)

    s = _sub("whoami", help="显示当前 actor + 可访问项目")
    s.set_defaults(func=cmd_whoami)

    s = _sub("config", help="本地配置")
    cs = s.add_subparsers(dest="config_cmd", required=True)
    cs.add_parser("show", help="打印当前配置", parents=[shared]).set_defaults(func=cmd_config_show)

    s = _sub("project", help="项目")
    ps = s.add_subparsers(dest="project_cmd", required=True)
    ps.add_parser("list", help="列出可访问项目", parents=[shared]).set_defaults(func=cmd_project_list)
    sw = ps.add_parser("switch", help="切换默认项目", parents=[shared])
    sw.add_argument("project_id")
    sw.set_defaults(func=cmd_project_switch)

    # run
    s = _sub("run", help="Run 资源")
    rs = s.add_subparsers(dest="run_cmd", required=True)
    r = rs.add_parser("list", help="列 Run", parents=[shared])
    r.add_argument("--status", help="逗号分隔，e.g. running,queued")
    r.add_argument("--kind")
    r.add_argument("--limit", type=int, default=20)
    r.set_defaults(func=cmd_run_list)
    r = rs.add_parser("get", help="单 Run 详情", parents=[shared])
    r.add_argument("run_id")
    r.add_argument("--full", action="store_true", help="附带 specs + lineage")
    r.set_defaults(func=cmd_run_get)
    r = rs.add_parser("create", help="创建 Run", parents=[shared])
    r.add_argument("--from-file", help="从 JSON 文件读取整个 body")
    r.add_argument("--hwspec-hash")
    r.add_argument("--model-hash")
    r.add_argument("--strategy-hash")
    r.add_argument("--workload-hash")
    r.add_argument("--title")
    r.add_argument("--kind", default="train")
    r.set_defaults(func=cmd_run_create)
    r = rs.add_parser("cancel", help="取消 Run", parents=[shared])
    r.add_argument("run_id")
    r.set_defaults(func=cmd_run_cancel)
    r = rs.add_parser("kick", help="唤醒 engine-svc 立即处理", parents=[shared])
    r.add_argument("run_id")
    r.set_defaults(func=cmd_run_kick)
    r = rs.add_parser("tail", help="跟踪 engine.log 流", parents=[shared])
    r.add_argument("run_id")
    r.set_defaults(func=cmd_run_tail)

    # spec
    s = _sub("spec", help="Spec (HwSpec / model / strategy / workload)")
    ss = s.add_subparsers(dest="spec_cmd", required=True)
    sp = ss.add_parser("get", help="获取 latest 版本", parents=[shared])
    sp.add_argument("kind", choices=("hwspec", "model", "strategy", "workload"))
    sp.add_argument("spec_id")
    sp.set_defaults(func=cmd_spec_get)
    sp = ss.add_parser("versions", help="列出所有版本", parents=[shared])
    sp.add_argument("kind"); sp.add_argument("spec_id")
    sp.set_defaults(func=cmd_spec_versions)
    sp = ss.add_parser("diff", help="对比两个版本", parents=[shared])
    sp.add_argument("kind"); sp.add_argument("spec_id")
    sp.add_argument("from_hash"); sp.add_argument("to_hash")
    sp.set_defaults(func=cmd_spec_diff)
    sp = ss.add_parser("fork", help="派生新 spec", parents=[shared])
    sp.add_argument("kind"); sp.add_argument("spec_id")
    sp.add_argument("--new-name", required=True)
    sp.add_argument("--from-hash", help="基于哪个 hash 派生（默认 latest）")
    sp.set_defaults(func=cmd_spec_fork)
    sp = ss.add_parser("snapshot", help="提交新版本（hash 服务端算）", parents=[shared])
    sp.add_argument("kind"); sp.add_argument("spec_id")
    sp.add_argument("--from-file", required=True, help="JSON body 文件")
    sp.add_argument("--tag", help="可选 version_tag")
    sp.set_defaults(func=cmd_spec_snapshot)

    return p


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    cfg = load_config()
    try:
        return args.func(args, cfg)
    except AuthError as e:
        if e.status == 401:
            fmt.err("未登录或 token 已过期。运行 `bytesim login <user_id>` 重新登录。")
        else:
            fmt.err(f"无权访问当前项目：{e.body[:200]}")
        return 1
    except NotFoundError as e:
        fmt.err(f"资源不存在：{e.path}")
        return 1
    except ApiError as e:
        fmt.err(f"API 错误 {e.status}：{e.body[:200]}")
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
