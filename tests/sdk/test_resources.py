"""Resource methods — verify both the URL/payload shape (against real BFF
routes) and the SDK ergonomics (default kwargs, return parsing)."""
from unittest.mock import AsyncMock


def test_runs_get_calls_through_to_bff(bff_app, logged_in):
    bff_app.state.run_svc.get_run = AsyncMock(return_value={"id": "sim-7f2a", "status": "running"})
    out = logged_in.runs.get("sim-7f2a")
    assert out["id"] == "sim-7f2a"
    bff_app.state.run_svc.get_run.assert_awaited_once_with("sim-7f2a")


def test_runs_create_kicks_engine_and_returns_id(bff_app, logged_in):
    bff_app.state.run_svc.create_run = AsyncMock(return_value={"id": "sim-new", "status": "queued"})
    bff_app.state.engine_svc.kick = AsyncMock()
    out = logged_in.runs.create(hwspec_hash="h", model_hash="m", title="t")
    assert out["id"] == "sim-new"
    body = bff_app.state.run_svc.create_run.await_args.args[0]
    assert body["hwspec_hash"] == "h"
    assert body["title"] == "t"
    # actor_id propagated from session.
    assert body.get("created_by") == "songwenjun"
    bff_app.state.engine_svc.kick.assert_awaited_once_with("sim-new")


def test_specs_get(bff_app, logged_in):
    bff_app.state.asset_svc.get_latest = AsyncMock(return_value={
        "spec": {"id": "h1"}, "version": {"hash": "abc"}})
    out = logged_in.specs.get("hwspec", "h1")
    assert out["spec"]["id"] == "h1"


def test_specs_versions(bff_app, logged_in):
    bff_app.state.asset_svc.list_versions = AsyncMock(return_value=[{"hash": "h1", "version_tag": "v1"}])
    out = logged_in.specs.versions("hwspec", "h1")
    assert isinstance(out, list)
    assert out[0]["version_tag"] == "v1"


def test_specs_diff(bff_app, logged_in):
    bff_app.state.asset_svc.diff = AsyncMock(return_value={"entries": [{"path": "x", "op": "changed"}]})
    out = logged_in.specs.diff("hwspec", "h1", "a", "b")
    assert out["entries"][0]["op"] == "changed"
    bff_app.state.asset_svc.diff.assert_awaited_once_with("hwspec", "h1", "a", "b")


def test_specs_fork_returns_new_spec(bff_app, logged_in):
    bff_app.state.asset_svc.fork = AsyncMock(return_value={
        "spec": {"id": "h2"}, "version": {"hash": "xyz", "version_tag": "v1"}})
    out = logged_in.specs.fork("hwspec", "h1", new_name="my-fork")
    assert out["spec"]["id"] == "h2"


def test_specs_snapshot(bff_app, logged_in):
    bff_app.state.asset_svc.snapshot = AsyncMock(return_value={
        "hash": "newhash", "version_tag": "v5", "spec_id": "h1"})
    out = logged_in.specs.snapshot("hwspec", "h1", body={"power": 999})
    assert out["hash"] == "newhash"
