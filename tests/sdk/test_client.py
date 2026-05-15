"""Client + auth: real auth flow against the live BFF, error mapping,
project switch, and the 401 / 403 / 404 paths."""
from unittest.mock import AsyncMock

import pytest


def test_login_persists_token_to_config(bff_app, base_url, tmp_config_file):
    from bytesim.auth import login
    cfg = login("songwenjun", base_url=base_url)
    assert cfg.token and "." in cfg.token
    assert cfg.actor_id == "songwenjun"
    assert cfg.project in ("p_default", "p_lab")
    assert tmp_config_file.exists()


def test_login_unknown_user_raises_auth_error(base_url, tmp_config_file):
    from bytesim.auth import login
    from bytesim.errors import AuthError
    with pytest.raises(AuthError):
        login("ghost", base_url=base_url)


def test_logout_drops_token(bff_app, base_url, tmp_config_file):
    from bytesim.auth import login, logout
    from bytesim.config import load_config
    login("songwenjun", base_url=base_url)
    assert load_config().token
    logout()
    assert load_config().token is None


def test_whoami_returns_actor_and_projects(logged_in):
    me = logged_in.whoami()
    assert me["actor_id"] == "songwenjun"
    assert "projects" in me


def test_use_project_switches_header(bff_app, base_url, tmp_config_file):
    from bytesim.auth import login
    from bytesim.client import Client
    cfg = login("songwenjun", base_url=base_url)
    c = Client(config=cfg)
    c.use_project("p_lab")
    assert c.whoami()["project_id"] == "p_lab"


def test_cross_project_raises_auth_error(bff_app, base_url, tmp_config_file):
    """alice is bound to p_lab only — asking for p_default must fail."""
    from bytesim.auth import login
    from bytesim.client import Client
    from bytesim.errors import AuthError
    cfg = login("alice", base_url=base_url)
    c = Client(config=cfg, project="p_default")
    with pytest.raises(AuthError):
        c.whoami()


def test_no_token_raises_auth_error(base_url, tmp_config_file):
    from bytesim.client import Client
    from bytesim.errors import AuthError
    c = Client(base_url=base_url, token=None, project="p_default")
    with pytest.raises(AuthError):
        c.whoami()


def test_404_maps_to_notfound(bff_app, logged_in):
    from bytesim.errors import NotFoundError
    bff_app.state.run_svc.get_run = AsyncMock(side_effect=RuntimeError("404 not found"))
    bff_app.state.run_svc.get_specs = AsyncMock(return_value=[])
    bff_app.state.run_svc.get_lineage = AsyncMock(return_value={})
    with pytest.raises(NotFoundError):
        logged_in.runs.get_full("ghost")


def test_5xx_maps_to_apierror(bff_app, logged_in):
    from bytesim.errors import ApiError
    bff_app.state.run_svc.get_run = AsyncMock(side_effect=RuntimeError("upstream"))
    with pytest.raises(ApiError) as e:
        logged_in.runs.get("sim-x")
    assert e.value.status >= 500
