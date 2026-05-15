#!/usr/bin/env bash
# Start the 4-host cross-machine simulation in dependency order.
#
# First run will build 5 Python images + the data_svc Go image
# (~10-15 min depending on network). Subsequent runs reuse cached layers.
#
# Pre-check:
#   - dashboard/output/ must exist (run `cd dashboard && ./build.sh` first)
#   - Docker Desktop running

set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -d ../../dashboard/output/dist ]]; then
  echo "error: dashboard/output/dist/ missing." >&2
  echo "       run 'cd ../../dashboard && ./build.sh' first." >&2
  exit 1
fi

# Bring up in tier order. Each compose creates its own isolated bridge
# network — no cross-bridge DNS — so the containers behave like they're on
# separate machines connected only via the host's localhost + published ports.
echo "==> [1/4] host C — postgres + data_svc"
docker compose -f docker-compose.host-c.yml up -d --build

echo "==> [2/4] host D — registry + surrogate + tco + engine_svc"
docker compose -f docker-compose.host-d.yml up -d --build

echo "==> [3/4] host B — bff"
docker compose -f docker-compose.host-b.yml up -d --build

echo "==> [4/4] host A — nginx + dashboard"
docker compose -f docker-compose.host-a.yml up -d

echo ""
echo "All hosts started. Wait ~10s for engines to self-register, then:"
echo "  bash verify.sh        — run the 7-level verification"
echo "  open http://localhost:8443/   — the dashboard SPA"
