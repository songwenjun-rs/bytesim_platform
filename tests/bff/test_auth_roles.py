"""§7: role propagated through JWT + middleware to request.state.role."""
from __future__ import annotations


def test_login_response_includes_role(client):
    r = client.post("/v1/auth/login", json={"user_id": "songwenjun", "password": "x"})
    body = r.json()
    assert body["role"] == "admin"


def test_login_data_steward_user(client):
    r = client.post("/v1/auth/login", json={"user_id": "lihaoran", "password": "x"})
    assert r.json()["role"] == "data_steward"


def test_login_unknown_user_rejected_still(client):
    r = client.post("/v1/auth/login", json={"user_id": "ghost", "password": "x"})
    assert r.status_code == 401


def test_me_returns_role(client, auth_headers):
    r = client.get("/v1/auth/me", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["role"] == "admin"  # songwenjun = admin
    assert body["actor_id"] == "songwenjun"


def test_jwt_carries_role():
    """mint_token must embed role; verify_token must round-trip it."""
    from app.auth import mint_token, verify_token  # type: ignore
    t = mint_token("alice", ["p_lab"], role="data_steward")
    p = verify_token(t)
    assert p is not None
    assert p["role"] == "data_steward"


def test_mint_token_default_role_from_user_roles():
    """When role is None, fall back to USER_ROLES lookup."""
    from app.auth import mint_token, verify_token  # type: ignore
    t = mint_token("songwenjun", ["p_default"])
    p = verify_token(t)
    assert p["role"] == "admin"


def test_mint_token_unknown_user_gets_default_role():
    """Unknown user_id in mint_token still works (e.g. service-to-service tokens),
    falls back to DEFAULT_ROLE = analyst."""
    from app.auth import mint_token, verify_token  # type: ignore
    t = mint_token("unknown-svc-account", ["p_default"])
    p = verify_token(t)
    assert p["role"] == "analyst"


def test_legacy_token_without_role_still_authenticates(client):
    """Tokens minted before §7 don't have a `role` claim. Middleware must
    still let them in (falling back to USER_ROLES lookup)."""
    import base64, hashlib, hmac, json, time, os
    secret = os.environ["BFF_JWT_SECRET"]
    header = base64.urlsafe_b64encode(json.dumps(
        {"alg": "HS256", "typ": "JWT"}, separators=(",", ":")
    ).encode()).rstrip(b"=").decode()
    payload = base64.urlsafe_b64encode(json.dumps(
        {"sub": "songwenjun", "projects": ["p_default"], "iat": int(time.time()),
         "exp": int(time.time()) + 3600}, separators=(",", ":")
    ).encode()).rstrip(b"=").decode()
    sig = base64.urlsafe_b64encode(
        hmac.new(secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()
    ).rstrip(b"=").decode()
    legacy_token = f"{header}.{payload}.{sig}"

    r = client.get("/v1/auth/me", headers={"Authorization": f"Bearer {legacy_token}"})
    assert r.status_code == 200
    # Falls back to USER_ROLES lookup
    assert r.json()["role"] == "admin"
