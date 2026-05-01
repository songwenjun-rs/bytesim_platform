"""CLI: invoke main() programmatically against the live BFF, capture
stdout/stderr, assert exit code + payload shape.
"""
from unittest.mock import AsyncMock


def run_cli(argv):
    """Invoke bytesim CLI with `argv`; relies on tmp_config_file and
    base_url being passed in via --base-url on the actual login call."""
    import bytesim.cli.main as cli
    return cli.main(argv)


def test_login_then_whoami(bff_app, base_url, tmp_config_file, capsys):
    code = run_cli(["login", "songwenjun", "--base-url", base_url])
    assert code == 0
    code = run_cli(["whoami", "--format", "json"])
    assert code == 0
    out = capsys.readouterr().out
    assert "songwenjun" in out
    assert "p_default" in out or "p_lab" in out


def test_whoami_without_login_errors(base_url, tmp_config_file, capsys):
    code = run_cli(["whoami"])
    assert code == 1
    err = capsys.readouterr().err
    assert "未登录" in err


def test_login_unknown_user_returns_nonzero(base_url, tmp_config_file, capsys):
    code = run_cli(["login", "ghost", "--base-url", base_url])
    assert code == 1


def test_project_list_and_switch(bff_app, base_url, tmp_config_file, capsys):
    run_cli(["login", "songwenjun", "--base-url", base_url])
    code = run_cli(["project", "list", "--format", "json"])
    assert code == 0
    out = capsys.readouterr().out
    assert "p_default" in out and "p_lab" in out

    code = run_cli(["project", "switch", "p_lab"])
    assert code == 0
    from bytesim.config import load_config
    assert load_config().project == "p_lab"


def test_run_get_routes_through(bff_app, base_url, tmp_config_file, capsys):
    run_cli(["login", "songwenjun", "--base-url", base_url])
    bff_app.state.run_svc.get_run = AsyncMock(return_value={"id": "sim-7f2a", "status": "running"})
    code = run_cli(["run", "get", "sim-7f2a", "--format", "json"])
    assert code == 0
    out = capsys.readouterr().out
    assert "sim-7f2a" in out


def test_run_create_requires_hashes(bff_app, base_url, tmp_config_file, capsys):
    run_cli(["login", "songwenjun", "--base-url", base_url])
    code = run_cli(["run", "create"])
    assert code == 2
    err = capsys.readouterr().err
    assert "hwspec" in err.lower() or "model" in err.lower()


def test_run_create_happy_path(bff_app, base_url, tmp_config_file, capsys):
    run_cli(["login", "songwenjun", "--base-url", base_url])
    bff_app.state.run_svc.create_run = AsyncMock(return_value={"id": "sim-new", "status": "queued"})
    bff_app.state.engine_svc.kick = AsyncMock()
    code = run_cli([
        "run", "create",
        "--hwspec-hash", "h", "--model-hash", "m", "--title", "x",
    ])
    assert code == 0
    out = capsys.readouterr()
    assert "sim-new" in out.err or "sim-new" in out.out


def test_run_cancel_running_emits_kafka(bff_app, base_url, tmp_config_file, capsys):
    run_cli(["login", "songwenjun", "--base-url", base_url])
    bff_app.state.run_svc.cancel_run = AsyncMock(return_value={"was_running": True, "id": "x"})
    bff_app.state.event_bus.publish = AsyncMock()
    code = run_cli(["run", "cancel", "x"])
    assert code == 0
    bff_app.state.event_bus.publish.assert_awaited_once()


def test_spec_diff_table(bff_app, base_url, tmp_config_file, capsys):
    run_cli(["login", "songwenjun", "--base-url", base_url])
    bff_app.state.asset_svc.diff = AsyncMock(return_value={
        "entries": [
            {"path": "power.peak_kw", "op": "changed", "from": 680, "to": 820},
            {"path": "power.cooling", "op": "added", "to": "DLC"},
        ],
    })
    code = run_cli(["spec", "diff", "hwspec", "h1", "abc", "def"])
    assert code == 0
    out = capsys.readouterr().out
    assert "power.peak_kw" in out and "changed" in out


def test_spec_diff_empty_says_identical(bff_app, base_url, tmp_config_file, capsys):
    run_cli(["login", "songwenjun", "--base-url", base_url])
    bff_app.state.asset_svc.diff = AsyncMock(return_value={"entries": []})
    code = run_cli(["spec", "diff", "hwspec", "h1", "a", "b"])
    assert code == 0
    err = capsys.readouterr().err
    assert "结构相同" in err


def test_format_json_returns_parseable_json(bff_app, base_url, tmp_config_file, capsys):
    import json
    run_cli(["login", "songwenjun", "--base-url", base_url])
    bff_app.state.run_svc.get_run = AsyncMock(return_value={"id": "sim-x", "status": "done"})
    run_cli(["run", "get", "sim-x", "--format", "json"])
    out = capsys.readouterr().out
    parsed = json.loads(out)
    assert parsed["id"] == "sim-x"


def test_config_show(bff_app, base_url, tmp_config_file, capsys):
    run_cli(["login", "songwenjun", "--base-url", base_url])
    code = run_cli(["config", "show", "--format", "json"])
    assert code == 0
    out = capsys.readouterr().out
    import json
    parsed = json.loads(out)
    assert parsed["actor_id"] == "songwenjun"
    assert parsed["base_url"] == base_url
    assert parsed["token"].endswith("…")


def test_logout_clears_token(bff_app, base_url, tmp_config_file):
    run_cli(["login", "songwenjun", "--base-url", base_url])
    from bytesim.config import load_config
    assert load_config().token
    code = run_cli(["logout"])
    assert code == 0
    assert load_config().token is None
