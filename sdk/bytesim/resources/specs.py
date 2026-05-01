"""Specs — HwSpec / model / strategy / workload, all share the same routes."""
from __future__ import annotations

from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from ..client import Client


class Specs:
    def __init__(self, client: "Client") -> None:
        self._c = client

    def get(self, kind: str, spec_id: str) -> dict[str, Any]:
        """Latest version of a spec, with its full body."""
        return self._c.get(f"/v1/specs/{kind}/{spec_id}")

    def versions(self, kind: str, spec_id: str) -> list[dict[str, Any]]:
        return self._c.get(f"/v1/specs/{kind}/{spec_id}/versions")

    def diff(self, kind: str, spec_id: str, from_hash: str, to_hash: str) -> dict[str, Any]:
        """Recursive JSON diff between two versions. `entries` is sorted by path."""
        return self._c.get(
            f"/v1/specs/{kind}/{spec_id}/diff",
            params={"from": from_hash, "to": to_hash},
        )

    def fork(
        self, kind: str, spec_id: str, *,
        new_name: str,
        from_hash: str | None = None,
        new_spec_id: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"new_name": new_name}
        if from_hash: body["from_hash"] = from_hash
        if new_spec_id: body["new_spec_id"] = new_spec_id
        return self._c.post(f"/v1/specs/{kind}/{spec_id}/fork", body)

    def snapshot(self, kind: str, spec_id: str, *, body: dict[str, Any], version_tag: str | None = None) -> dict[str, Any]:
        """Create a new version with `body`. Hash is computed server-side."""
        payload: dict[str, Any] = {"body": body}
        if version_tag: payload["version_tag"] = version_tag
        return self._c.post(f"/v1/specs/{kind}/{spec_id}/snapshot", payload)
