"""HTTP-level tests for ingest-svc with mocked Store."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("INGEST_STORAGE_ROOT", str(tmp_path))
    from app.main import app as fastapi_app  # type: ignore
    fastapi_app.router.lifespan_context = None
    fastapi_app.state.store = AsyncMock()
    fastapi_app.state.samples_cache = {}
    # Make sure storage dir exists (lifespan was disabled)
    tmp_path.mkdir(parents=True, exist_ok=True)
    return fastapi_app


@pytest.fixture
def client(app):
    return TestClient(app)


CSV_BODY = (
    b"timestamp,gpu_model,sm_util_pct,step_ms\n"
    b"2026-01-01T00:00:00Z,B200,47.3,540.5\n"
    b"2026-01-01T00:00:01Z,B200,48.0,535.0\n"
)


def _stub_snapshot(sid="snap-abc12345", **overrides):
    base = {
        "id": sid, "project_id": "p_default", "name": "test",
        "source_kind": "dcgm", "source_adapter": "dcgm-csv@v1",
        "storage_uri": "file:///tmp/x", "sha256": "deadbeef",
        "row_count": 2, "bytes": len(CSV_BODY),
        "covers_period": {"lower": "2026-01-01T00:00:00+00:00", "upper": "2026-01-01T00:00:01+00:00"},
        "hardware_scope": {"gpu_models": ["B200"]},
        "workload_scope": {},
        "redaction": {},
        "imported_by": "tester",
        "approved_by": None, "approved_at": None,
        "status": "pending_review",
        "retention_until": None, "notes": None,
    }
    base.update(overrides)
    return base


def test_healthz(client):
    assert client.get("/healthz").status_code == 200


def test_list_adapters(client):
    out = client.get("/v1/adapters").json()
    names = [a["name"] for a in out]
    assert "dcgm-csv@v1" in names


def test_upload_dcgm_csv(client, app):
    app.state.store.insert_snapshot = AsyncMock(return_value=_stub_snapshot())
    app.state.store.get_snapshot = AsyncMock(return_value=_stub_snapshot())
    r = client.post(
        "/v1/snapshots",
        files={"file": ("dcgm.csv", CSV_BODY, "text/csv")},
        data={
            "project_id": "p_default",
            "name": "Q1 prod B200 sample",
            "source_kind": "dcgm",
            "source_adapter": "dcgm-csv@v1",
        },
        headers={"X-Actor-Id": "songwenjun"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "pending_review"
    # Verify samples got cached
    cached = list(app.state.samples_cache.values())
    assert cached and cached[0].row_count == 2


def test_upload_400_on_unknown_adapter(client):
    r = client.post(
        "/v1/snapshots",
        files={"file": ("x.csv", CSV_BODY, "text/csv")},
        data={"name": "x", "source_kind": "dcgm", "source_adapter": "no-such@v9"},
    )
    assert r.status_code == 400
    assert "unknown adapter" in r.json()["detail"]


def test_upload_400_on_adapter_failure(client):
    r = client.post(
        "/v1/snapshots",
        files={"file": ("bad.csv", b"not valid csv at all", "text/csv")},
        data={"name": "x", "source_kind": "dcgm", "source_adapter": "dcgm-csv@v1"},
    )
    assert r.status_code == 400
    assert "adapter" in r.json()["detail"].lower()


def test_upload_400_on_invalid_redaction_json(client, app):
    app.state.store.insert_snapshot = AsyncMock(return_value=_stub_snapshot())
    r = client.post(
        "/v1/snapshots",
        files={"file": ("dcgm.csv", CSV_BODY, "text/csv")},
        data={"name": "x", "source_kind": "dcgm", "source_adapter": "dcgm-csv@v1",
               "redaction_attest": "not-json"},
    )
    assert r.status_code == 400


def test_list_snapshots(client, app):
    app.state.store.list_snapshots = AsyncMock(return_value=[_stub_snapshot()])
    r = client.get("/v1/snapshots?status=pending_review")
    assert r.status_code == 200
    assert r.json()[0]["id"] == "snap-abc12345"
    app.state.store.list_snapshots.assert_awaited_with(
        project_id=None, status="pending_review", source_kind=None, limit=50,
    )


def test_get_snapshot_404(client, app):
    app.state.store.get_snapshot = AsyncMock(return_value=None)
    assert client.get("/v1/snapshots/missing").status_code == 404


def test_get_snapshot_ok(client, app):
    app.state.store.get_snapshot = AsyncMock(return_value=_stub_snapshot())
    r = client.get("/v1/snapshots/snap-abc12345")
    assert r.status_code == 200


def test_approve_requires_data_steward(client, app):
    r = client.post("/v1/snapshots/snap-abc12345/approve",
                    json={"actor_id": "alice"},
                    headers={"X-Actor-Role": "viewer"})
    assert r.status_code == 403


def test_approve_data_steward_ok(client, app):
    app.state.store.approve = AsyncMock(return_value=True)
    app.state.store.get_snapshot = AsyncMock(return_value=_stub_snapshot(
        status="approved", approved_by="alice"))
    r = client.post("/v1/snapshots/snap-abc12345/approve",
                    json={"actor_id": "alice"},
                    headers={"X-Actor-Role": "data_steward"})
    assert r.status_code == 200
    assert r.json()["status"] == "approved"


def test_approve_admin_also_ok(client, app):
    """Admin role can also approve (escalation path)."""
    app.state.store.approve = AsyncMock(return_value=True)
    app.state.store.get_snapshot = AsyncMock(return_value=_stub_snapshot(status="approved"))
    r = client.post("/v1/snapshots/snap-abc12345/approve",
                    json={"actor_id": "admin"},
                    headers={"X-Actor-Role": "admin"})
    assert r.status_code == 200


def test_approve_409_when_not_pending(client, app):
    app.state.store.approve = AsyncMock(return_value=False)
    r = client.post("/v1/snapshots/snap-abc12345/approve",
                    json={"actor_id": "alice"},
                    headers={"X-Actor-Role": "data_steward"})
    assert r.status_code == 409


def test_reject(client, app):
    app.state.store.reject = AsyncMock(return_value=True)
    app.state.store.get_snapshot = AsyncMock(return_value=_stub_snapshot(status="rejected"))
    r = client.post("/v1/snapshots/snap-abc12345/reject",
                    json={"actor_id": "alice", "reason": "missing redaction"},
                    headers={"X-Actor-Role": "data_steward"})
    assert r.status_code == 200
    assert r.json()["status"] == "rejected"


def test_reject_403_no_role(client, app):
    r = client.post("/v1/snapshots/snap-abc12345/reject",
                    json={"actor_id": "alice"},
                    headers={"X-Actor-Role": "analyst"})
    assert r.status_code == 403


def test_get_samples_404_when_missing(client, app):
    app.state.store.get_snapshot = AsyncMock(return_value=None)
    assert client.get("/v1/snapshots/no/samples").status_code == 404


def test_get_samples_409_when_not_approved(client, app):
    app.state.store.get_snapshot = AsyncMock(return_value=_stub_snapshot(status="pending_review"))
    r = client.get("/v1/snapshots/snap-abc12345/samples")
    assert r.status_code == 409


def test_get_samples_returns_extracted_rows(client, app):
    """Approved snapshot + samples cached → returns the rows."""
    from app.adapters import adapt_dcgm_csv
    app.state.store.get_snapshot = AsyncMock(return_value=_stub_snapshot(
        status="approved",
    ))
    app.state.samples_cache["snap-abc12345"] = adapt_dcgm_csv(CSV_BODY)
    r = client.get("/v1/snapshots/snap-abc12345/samples")
    assert r.status_code == 200
    body = r.json()
    assert body["row_count"] == 2
    assert len(body["samples"]) == 2


def test_record_consumer(client, app):
    app.state.store.get_snapshot = AsyncMock(return_value=_stub_snapshot(status="approved"))
    app.state.store.record_consumer = AsyncMock()
    r = client.post("/v1/snapshots/snap-abc12345/consumers",
                    json={"consumer_kind": "calibration_job", "consumer_id": "cal-1"})
    assert r.status_code == 200
    app.state.store.record_consumer.assert_awaited_with(
        "snap-abc12345", "calibration_job", "cal-1",
    )


def test_record_consumer_400_when_missing_fields(client, app):
    r = client.post("/v1/snapshots/x/consumers", json={"only": "this"})
    assert r.status_code == 400


def test_list_consumers(client, app):
    app.state.store.list_consumers = AsyncMock(return_value=[
        {"snapshot_id": "snap-abc12345", "consumer_kind": "calibration_job",
         "consumer_id": "cal-1", "consumed_at": "2026-04-25T00:00:00+00:00"},
    ])
    r = client.get("/v1/snapshots/snap-abc12345/consumers")
    assert r.status_code == 200
    assert r.json()[0]["consumer_id"] == "cal-1"
