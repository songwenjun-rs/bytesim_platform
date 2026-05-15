"""ByteSim platform SDK.

Two surfaces:

1. **Client** — programmatic, for use in notebooks, scripts, CI:

       from bytesim import Client
       c = Client()  # reads ~/.bytesim/config.toml
       run = c.runs.get("sim-7f2a")

2. **CLI** — `bytesim run get sim-7f2a` after `pip install bytesim`.

Both share the same auth + config layer so a `bytesim login` from the shell
is immediately available to a notebook in the same workspace.
"""
from .client import Client
from .config import Config, load_config, save_config
from .errors import ApiError, AuthError, NotFoundError

__version__ = "0.1.0"

__all__ = [
    "Client",
    "Config",
    "load_config",
    "save_config",
    "ApiError",
    "AuthError",
    "NotFoundError",
    "__version__",
]
