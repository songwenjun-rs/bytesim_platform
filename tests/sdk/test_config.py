"""Config: load/save roundtrip + env-var overrides + chmod 0600."""
import os
import stat


def test_load_returns_defaults_when_file_missing(tmp_config_file):
    from bytesim.config import load_config
    cfg = load_config()
    assert cfg.base_url.startswith("http")
    assert cfg.token is None
    assert cfg.project is None


def test_save_then_load_roundtrip(tmp_config_file):
    from bytesim.config import Config, load_config, save_config
    save_config(Config(base_url="http://foo", token="t-1", project="p_lab", actor_id="alice"))
    cfg = load_config()
    assert cfg.base_url == "http://foo"
    assert cfg.token == "t-1"
    assert cfg.project == "p_lab"
    assert cfg.actor_id == "alice"


def test_env_vars_override_file(tmp_config_file, monkeypatch):
    from bytesim.config import Config, load_config, save_config
    save_config(Config(base_url="http://foo", token="t-1", project="p_default", actor_id="alice"))
    monkeypatch.setenv("BYTESIM_PROJECT", "p_lab")
    monkeypatch.setenv("BYTESIM_TOKEN", "t-env")
    cfg = load_config()
    assert cfg.project == "p_lab"
    assert cfg.token == "t-env"
    assert cfg.base_url == "http://foo"  # not overridden


def test_save_sets_0600(tmp_config_file):
    from bytesim.config import Config, save_config
    save_config(Config(token="secret"))
    mode = stat.S_IMODE(os.stat(tmp_config_file).st_mode)
    # only owner-rw bits set; group + world cleared.
    assert mode & 0o077 == 0


def test_save_omits_none_fields(tmp_config_file):
    from bytesim.config import Config, save_config
    save_config(Config(base_url="http://x"))  # no token, no project
    body = tmp_config_file.read_text()
    assert "token" not in body
    assert "project" not in body


def test_extra_keys_round_trip(tmp_config_file):
    from bytesim.config import Config, load_config, save_config
    save_config(Config(extra={"some_flag": "abc"}))
    assert "some_flag" in load_config().extra
