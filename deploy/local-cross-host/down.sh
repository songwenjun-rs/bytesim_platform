#!/usr/bin/env bash
# Tear down everything started by up.sh.
#
# Postgres uses the EXTERNAL volume bytesim_platform_pgdata (shared with the
# main docker-compose.yml dev stack), so even `--clean` does NOT wipe it.
# To actually delete that volume, do it explicitly with:
#   docker volume rm bytesim_platform_pgdata

set -euo pipefail
cd "$(dirname "$0")"

CLEAN=""
[[ "${1:-}" == "--clean" ]] && CLEAN="--volumes"

# Tear down in reverse-of-up order (not strictly required; compose handles it).
for f in docker-compose.host-a.yml docker-compose.host-b.yml \
         docker-compose.host-d.yml docker-compose.host-c.yml \
         docker-compose.postgres.yml; do
  docker compose -f "$f" down $CLEAN 2>/dev/null || true
done

echo "done."
echo "  --clean removes the host-c local volume (none with the new layout)."
echo "  External volume bytesim_platform_pgdata is preserved — wipe it"
echo "  explicitly with \`docker volume rm bytesim_platform_pgdata\` if needed."
