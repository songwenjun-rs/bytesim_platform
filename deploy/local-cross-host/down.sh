#!/usr/bin/env bash
# Tear down everything started by up.sh.
# Use --volumes to also drop the postgres data volume.

set -euo pipefail
cd "$(dirname "$0")"

CLEAN=""
[[ "${1:-}" == "--clean" ]] && CLEAN="--volumes"

# Reverse order doesn't actually matter (compose stops cleanly either way).
for f in docker-compose.host-a.yml docker-compose.host-b.yml \
         docker-compose.host-d.yml docker-compose.host-c.yml; do
  docker compose -f "$f" down $CLEAN 2>/dev/null || true
done

echo "done. (pass --clean to also wipe postgres data volume)"
