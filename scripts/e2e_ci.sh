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
#   chakra-cache-ls.txt    contents of astra-sim's chakra trace cache (RFC-003)
#   astra-sim-svc.log      already covered by per-service loop, but the cache
#                          listing tells us if any traces were even generated
#                          when stage 15 fails ("0 entries" → writer never fired;
#                          "N entries" → writer fired but binary rejected them)
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
    for svc in bff run-svc engine-svc \
               surrogate-svc asset-svc redpanda postgres \
               astra-sim-svc engine-registry-svc; do
      docker compose logs --no-color --tail=200 "$svc" > "$LOG_DIR/$svc.log" 2>&1 || true
    done
    # RFC-003 — astra-sim chakra trace cache. When stage 15 (chakra round-trip)
    # fails, knowing whether any traces were even generated is the fastest
    # triage: empty cache means writer crashed before write; non-empty means
    # binary rejected the trace (look at astra-sim-svc.log for the exit / parse
    # error). The cache lives in a named volume (`chakra-cache:/var/cache/...`),
    # so we exec into the container to read it.
    docker compose exec -T astra-sim-svc \
        sh -c 'ls -la /var/cache/bytesim/chakra/chakra-cache/ 2>/dev/null
               echo "---"
               echo "spec.json files (one per cached trace):"
               find /var/cache/bytesim/chakra/chakra-cache -name spec.json \
                    -exec sh -c "echo \"--- {}\"; cat {}" \; 2>/dev/null' \
        > "$LOG_DIR/chakra-cache-ls.txt" 2>&1 || true
    # RFC-001 v2 — engine registry state at failure time. /v1/engines lists
    # which engines self-registered + their last_seen_at; helpful when stage
    # 16 (heartbeat freshness) or stage 18 (auto-routing) fails because an
    # engine wasn't actually registered.
    docker compose exec -T engine-registry-svc \
        sh -c 'python -c "
import urllib.request, json
try:
    r = urllib.request.urlopen(\"http://localhost:8089/v1/engines\", timeout=2)
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
