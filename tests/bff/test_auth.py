"""Auth: JWT mint/verify + middleware gate + login + me + users."""
import time

import pytest


def test_jwt_mint_and_verify_roundtrip():
    from app.auth import mint_token, verify_token  # type: ignore
    t = mint_token("alice", ["p_lab"])
    payload = verify_token(t)
    assert payload is not None
    assert payload["sub"] == "alice"
    assert payload["projects"] == ["p_lab"]
    assert payload["exp"] > int(time.time())


def test_jwt_verify_rejects_tampered_payload():
    from app.auth import mint_token, verify_token  # type: ignore
    t = mint_token("alice", ["p_lab"])
    h, p, s = t.split(".")
    # Replace payload with a different valid base64 — sig won't match
    import base64, json
    bad_payload = {"sub": "evil", "projects": ["p_default"], "exp": int(time.time()) + 1000}
    bad_p = base64.urlsafe_b64encode(json.dumps(bad_payload).encode()).rstrip(b"=").decode()
    bogus = f"{h}.{bad_p}.{s}"
    assert verify_token(bogus) is None


def test_jwt_verify_rejects_bad_format():
    from app.auth import verify_token  # type: ignore
    assert verify_token("garbage") is None
    assert verify_token("a.b") is None
    assert verify_token("") is None


def test_jwt_verify_rejects_expired():
    from app.auth import mint_token, verify_token  # type: ignore
    import os
    # Mint with a TTL of 0 → already expired
    saved = os.environ.get("BFF_JWT_TTL")
    os.environ["BFF_JWT_TTL"] = "-1"
    try:
        # need to reload module so it picks up env
        import importlib, app.auth as a  # type: ignore
        importlib.reload(a)
        t = a.mint_token("alice", ["p_lab"])
        assert a.verify_token(t) is None
    finally:
        if saved is not None:
            os.environ["BFF_JWT_TTL"] = saved
        importlib.reload(a)


def test_login_success_returns_token_and_projects(client):
    r = client.post("/v1/auth/login", json={"user_id": "songwenjun", "password": "anything"})
    assert r.status_code == 200
    data = r.json()
    assert "token" in data and "." in data["token"]
    assert data["actor_id"] == "songwenjun"
    assert "p_default" in data["projects"]


def test_login_unknown_user_rejected(client):
    r = client.post("/v1/auth/login", json={"user_id": "ghost", "password": "x"})
    assert r.status_code == 401


def test_users_endpoint_is_public(client):
    r = client.get("/v1/auth/users")
    assert r.status_code == 200
    users = r.json()["users"]
    assert any(u["user_id"] == "alice" for u in users)


def test_healthz_is_public(client):
    r = client.get("/healthz")
    assert r.status_code == 200


def test_protected_endpoint_requires_token(client):
    r = client.get("/v1/auth/me")
    assert r.status_code == 401


def test_me_returns_actor_and_project(client, auth_headers):
    r = client.get("/v1/auth/me", headers=auth_headers)
    assert r.status_code == 200
    me = r.json()
    assert me["actor_id"] == "songwenjun"
    assert me["project_id"] == "p_default"
    assert "p_lab" in me["projects"]


def test_x_project_id_can_switch(client, login_token):
    headers = {"Authorization": f"Bearer {login_token}", "X-Project-ID": "p_lab"}
    r = client.get("/v1/auth/me", headers=headers)
    assert r.status_code == 200
    assert r.json()["project_id"] == "p_lab"


def test_cross_project_access_forbidden(client):
    """alice is bound only to p_lab — asking for p_default must 403."""
    r = client.post("/v1/auth/login", json={"user_id": "alice", "password": "x"})
    token = r.json()["token"]
    r = client.get("/v1/auth/me", headers={"Authorization": f"Bearer {token}", "X-Project-ID": "p_default"})
    assert r.status_code == 403


def test_alice_default_project_is_first_in_claim(client):
    r = client.post("/v1/auth/login", json={"user_id": "alice", "password": "x"})
    token = r.json()["token"]
    r = client.get("/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json()["project_id"] == "p_lab"


def test_invalid_bearer_returns_401(client):
    r = client.get("/v1/auth/me", headers={"Authorization": "Bearer not-a-jwt"})
    assert r.status_code == 401


def test_token_via_query_param_for_eventsource(client, login_token):
    """SSE/EventSource can't set headers; we accept ?token= as fallback."""
    r = client.get(f"/v1/auth/me?token={login_token}")
    assert r.status_code == 200
