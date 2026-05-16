#!/usr/bin/env bash
# scripts/e2e_ci.sh — CI wrapper around e2e.sh.
#
# Builds the stack, brings it up, runs e2e.sh, and dumps logs to
# /tmp/e2e-logs/ on failure (uploaded as a workflow artifact). Always tears
# down the compose stack at the end.
#
# Failure-time dumps:
#   ps.txt                 docker compose ps
#   all.log                last 400 lines across all services
#   <svc>.log              per-service tail (200 lines)
#   stepNN-*.json          response bodies dumped by e2e.sh's debug_dump on
#                          assertion failure (already lands in LOG_DIR)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${E2E_LOG_DIR:-/tmp/e2e-logs}"

cleanup() {
  local ec=$?
  if [ "$ec" -ne 0 ]; then
    mkdir -p "$LOG_DIR"
    echo "── e2e failed (exit $ec); collecting logs to $LOG_DIR ──" >&2
    docker compose ps      > "$LOG_DIR/ps.txt"      2>&1 || true
    docker compose logs --no-color --tail=400 > "$LOG_DIR/all.log" 2>&1 || true
    # Per-service tail to make scanning easier than one giant file.
    for svc in bff data_svc engine_svc \
               surrogate_svc postgres; do
      docker compose logs --no-color --tail=200 "$svc" > "$LOG_DIR/$svc.log" 2>&1 || true
    done
    # RFC-001 v2 — engine registry state at failure time. /v1/engines lists
    # which engines self-registered + their last_seen_at; helpful when stage
    # 16 (heartbeat freshness) or stage 18 (auto-routing) fails because an
    # engine wasn't actually registered. The registry surface is now served
    # by engine_svc since the merger.
    docker compose exec -T engine_svc \
        sh -c 'python -c "
import urllib.request, json
try:
    r = urllib.request.urlopen(\"http://localhost:8087/v1/engines\", timeout=2)
    print(json.dumps(json.loads(r.read()), indent=2, default=str))
except Exception as e:
    print(\"registry unreachable:\", e)
"' > "$LOG_DIR/engine-registry-state.json" 2>&1 || true
  fi
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  return $ec
}
trap cleanup EXIT

docker compose up -d --build
bash "$HERE/e2e.sh"
