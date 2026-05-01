"""Cover the thin proxy routes in bff/api/{runs, specs, calibration,
tuner}.py. These mostly forward to a downstream client + map exceptions to
HTTPException — easy to exercise with mocks."""
from unittest.mock import AsyncMock

import pytest


def test_runs_get_full(client, app, auth_headers):
    rs = app.state.run_svc
    rs.get_run = AsyncMock(return_value={"id": "sim-7f2a", "status": "running"})
    rs.get_specs = AsyncMock(return_value=[{"hash": "h1", "stale": False}])
    rs.get_lineage = AsyncMock(return_value={"self": {}, "parents": [], "children": [], "edges": []})
    r = client.get("/v1/runs/sim-7f2a/full", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["run"]["id"] == "sim-7f2a"
    assert body["derived"]["self_stale"] is False


def test_runs_get_full_marks_stale(client, app, auth_headers):
    rs = app.state.run_svc
    rs.get_run = AsyncMock(return_value={"id": "x"})
    rs.get_specs = AsyncMock(return_value=[{"hash": "h1", "stale": True}])
    rs.get_lineage = AsyncMock(return_value={"self": {}, "parents": [], "children": [], "edges": []})
    r = client.get("/v1/runs/x/full", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["derived"]["self_stale"] is True


def test_runs_get_full_404(client, app, auth_headers):
    rs = app.state.run_svc
    rs.get_run = AsyncMock(side_effect=RuntimeError("404 not found"))
    rs.get_specs = AsyncMock(return_value=[])
    rs.get_lineage = AsyncMock(return_value={})
    r = client.get("/v1/runs/ghost/full", headers=auth_headers)
    assert r.status_code == 404


def test_runs_get_full_502_on_other_errors(client, app, auth_headers):
    rs = app.state.run_svc
    rs.get_run = AsyncMock(side_effect=RuntimeError("conn refused"))
    rs.get_specs = AsyncMock(return_value=[])
    rs.get_lineage = AsyncMock(return_value={})
    r = client.get("/v1/runs/x/full", headers=auth_headers)
    assert r.status_code == 502


def test_runs_get_run(client, app, auth_headers):
    app.state.run_svc.get_run = AsyncMock(return_value={"id": "sim-7e90"})
    r = client.get("/v1/runs/sim-7e90", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["id"] == "sim-7e90"


def test_runs_kick(client, app, auth_headers):
    app.state.engine_svc.kick = AsyncMock(return_value={"kicked": True})
    r = client.post("/v1/runs/sim-7f2a/kick", headers=auth_headers)
    assert r.status_code == 200


def test_runs_create_kick_failure_is_silent(client, app, auth_headers):
    """Engine kick is best-effort — if it fails we still return the new Run."""
    app.state.run_svc.create_run = AsyncMock(return_value={"id": "sim-new"})
    app.state.engine_svc.kick = AsyncMock(side_effect=RuntimeError("boom"))
    r = client.post("/v1/runs", json={"hwspec_hash": "h", "model_hash": "m"}, headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["id"] == "sim-new"


def test_plans_crud(client, app, auth_headers):
    rs = app.state.run_svc
    rs.get_plan = AsyncMock(return_value={"id": "plan-1", "slots": []})
    rs.create_plan = AsyncMock(return_value={"id": "plan-new"})
    rs.add_plan_slot = AsyncMock(return_value={"slot": "A"})
    rs.remove_plan_slot = AsyncMock(return_value={"removed": "A"})

    assert client.get("/v1/plans/plan-1", headers=auth_headers).status_code == 200
    assert client.post("/v1/plans", json={"name": "p"}, headers=auth_headers).status_code == 200
    assert client.post("/v1/plans/plan-1/slots", json={"run_id": "r"}, headers=auth_headers).status_code == 200
    assert client.delete("/v1/plans/plan-1/slots/A", headers=auth_headers).status_code == 200


def test_plan_404(client, app, auth_headers):
    app.state.run_svc.get_plan = AsyncMock(side_effect=RuntimeError("plan not found"))
    r = client.get("/v1/plans/missing", headers=auth_headers)
    assert r.status_code == 404


def test_specs_proxy(client, app, auth_headers):
    a = app.state.asset_svc
    a.get_latest = AsyncMock(return_value={"spec": {"id": "h1"}, "version": {"hash": "x"}})
    a.list_versions = AsyncMock(return_value=[{"hash": "x"}])
    a.snapshot = AsyncMock(return_value={"hash": "y"})
    a.diff = AsyncMock(return_value={"entries": []})
    a.fork = AsyncMock(return_value={"spec": {"id": "h2"}, "version": {"hash": "x"}})

    r = client.get("/v1/specs/hwspec/h1", headers=auth_headers)
    assert r.status_code == 200
    r = client.get("/v1/specs/hwspec/h1/versions", headers=auth_headers)
    assert r.status_code == 200
    r = client.post("/v1/specs/hwspec/h1/snapshot", json={"body": {}}, headers=auth_headers)
    assert r.status_code == 200
    r = client.get("/v1/specs/hwspec/h1/diff?from=a&to=b", headers=auth_headers)
    assert r.status_code == 200
    r = client.post("/v1/specs/hwspec/h1/fork", json={"new_name": "y"}, headers=auth_headers)
    assert r.status_code == 200


# ── Error / validation branches for specs proxy ───────────────────────────

def test_specs_list_502_on_downstream_failure(client, app, auth_headers):
    app.state.asset_svc.list_specs = AsyncMock(side_effect=RuntimeError("boom"))
    r = client.get("/v1/specs/hwspec", headers=auth_headers)
    assert r.status_code == 502


def test_specs_get_502_on_downstream_failure(client, app, auth_headers):
    app.state.asset_svc.get_latest = AsyncMock(side_effect=RuntimeError("boom"))
    r = client.get("/v1/specs/hwspec/x", headers=auth_headers)
    assert r.status_code == 502


def test_specs_versions_502(client, app, auth_headers):
    app.state.asset_svc.list_versions = AsyncMock(side_effect=RuntimeError("boom"))
    r = client.get("/v1/specs/hwspec/x/versions", headers=auth_headers)
    assert r.status_code == 502


def test_specs_snapshot_400_on_missing_body(client, app, auth_headers):
    # No body field → 400 before downstream is touched.
    r = client.post("/v1/specs/hwspec/x/snapshot", json={"version_tag": "v9"},
                    headers=auth_headers)
    assert r.status_code == 400


def test_specs_snapshot_502_on_downstream_failure(client, app, auth_headers):
    app.state.asset_svc.snapshot = AsyncMock(side_effect=RuntimeError("boom"))
    r = client.post("/v1/specs/hwspec/x/snapshot", json={"body": {}}, headers=auth_headers)
    assert r.status_code == 502


def test_specs_diff_400_when_missing_query_params(client, app, auth_headers):
    r = client.get("/v1/specs/hwspec/x/diff", headers=auth_headers)
    assert r.status_code == 400


def test_specs_diff_502_on_downstream_failure(client, app, auth_headers):
    app.state.asset_svc.diff = AsyncMock(side_effect=RuntimeError("boom"))
    r = client.get("/v1/specs/hwspec/x/diff?from=a&to=b", headers=auth_headers)
    assert r.status_code == 502


def test_specs_fork_400_on_missing_new_name(client, app, auth_headers):
    r = client.post("/v1/specs/hwspec/x/fork", json={}, headers=auth_headers)
    assert r.status_code == 400


def test_specs_fork_502_on_downstream_failure(client, app, auth_headers):
    app.state.asset_svc.fork = AsyncMock(side_effect=RuntimeError("boom"))
    r = client.post("/v1/specs/hwspec/x/fork", json={"new_name": "y"},
                    headers=auth_headers)
    assert r.status_code == 502


