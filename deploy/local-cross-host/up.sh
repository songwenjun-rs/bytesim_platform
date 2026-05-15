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

# External Postgres volume check — we mount `bytesim_platform_pgdata` so
# the dashboard sees real specs / runs / templates / TCO accumulated from
# previous dev sessions (rather than a sparse fresh-init DB).
if ! docker volume inspect bytesim_platform_pgdata >/dev/null 2>&1; then
  echo "warning: external volume bytesim_platform_pgdata not found." >&2
  echo "         If this is intentional, run \`docker volume create bytesim_platform_pgdata\`" >&2
  echo "         and let the migrations re-init it. Otherwise this volume should already" >&2
  echo "         exist from the main docker-compose.yml stack." >&2
  exit 1
fi

# Bring up in dependency order. Postgres goes first as a standalone tier
# (mimicking real production: PG is its own managed service that other
# tiers connect to via env vars). Each compose creates its own isolated
# bridge network so the containers behave like they're on separate
# machines connected only via host.docker.internal + published ports.
echo "==> [1/5] standalone postgres (mounts external bytesim_platform_pgdata)"
docker compose -f docker-compose.postgres.yml up -d

echo "==> [2/5] host C — data_svc (talks to PG via host.docker.internal:15432)"
docker compose -f docker-compose.host-c.yml up -d --build

echo "==> [3/5] host D — registry + surrogate + tco + engine_svc"
docker compose -f docker-compose.host-d.yml up -d --build

echo "==> [4/5] host B — bff"
docker compose -f docker-compose.host-b.yml up -d --build

echo "==> [5/5] host A — nginx + dashboard"
docker compose -f docker-compose.host-a.yml up -d

echo ""
echo "All tiers started. Wait ~10s for engines to self-register, then:"
echo "  bash verify.sh                   — run the 7-level verification"
echo "  open http://localhost:8443/      — the dashboard SPA"
echo ""
echo "Direct DB access:"
echo "  psql -h localhost -p 15432 -U bytesim -d bytesim  (password: bytesim)"
