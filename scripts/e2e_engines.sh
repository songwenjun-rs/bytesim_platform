#!/usr/bin/env bash
# scripts/e2e_engines.sh — engine-layer-only smoke (RFC-001 v2).
#
# Five stages: health → login → registry visibility → envelope-miss 503 →
# auto-routing. surrogate-analytical is the only registered engine the
# platform ships by default; the assertions reflect that.
#
# Use:
#   make e2e-engines              # against running stack
#   E2E_USER=alice ./scripts/e2e_engines.sh
#
# Tunables (env): same as e2e.sh — BFF_URL, E2E_USER, PROJECT_ID, MAX_HEALTH_S.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/_lib.sh
source "$HERE/_lib.sh"

LOG_DIR="${E2E_LOG_DIR:-/tmp/e2e-logs}"
mkdir -p "$LOG_DIR" 2>/dev/null || true
debug_dump() {
    local fname="$1" body="$2"
    [ -d "$LOG_DIR" ] && printf '%s' "$body" > "$LOG_DIR/$fname" 2>/dev/null || true
}

BFF="${BFF_URL:-http://localhost:8080}"
E2E_USER="${E2E_USER:-songwenjun}"
export PROJECT_ID="${PROJECT_ID:-p_default}"
MAX_HEALTH_S="${MAX_HEALTH_S:-300}"

# ── 1/5 healthcheck ──────────────────────────────────────────────────
log "1/5 wait for BFF healthy at $BFF (max ${MAX_HEALTH_S}s)"
wait_for_url "$BFF/healthz" "$MAX_HEALTH_S"

# ── 2/5 login ────────────────────────────────────────────────────────
log "2/5 login as $E2E_USER"
LOGIN_BODY="$(curl_json POST "$BFF/v1/auth/login" \
  "{\"user_id\":\"$E2E_USER\",\"password\":\"\"}")"
JWT="$(json_get "$LOGIN_BODY" token)"
[ -n "$JWT" ] || fail "login returned empty token: $LOGIN_BODY"
export AUTH_HEADER="Authorization: Bearer $JWT"
ok   "  · token acquired (len=${#JWT})"

# ── 3/5 engine registry visibility + heartbeat freshness ─────────────
log "3/5 engine registry self-registration + heartbeat"
ENGINES_BODY="$(curl_auth GET "$BFF/v1/engines")"
debug_dump "engines-step3-engines.json" "$ENGINES_BODY"
assert_python "$ENGINES_BODY" '
import sys, json
import re
from datetime import datetime, timezone
engines = json.loads(sys.argv[1])
by_name = {e["name"]: e for e in engines}
required = "surrogate-analytical"
assert required in by_name, f"engine {required} not registered: {sorted(by_name)}"
e = by_name[required]
status = e["status"]
assert status == "active", f"{required} status={status} (expected active)"
fidelity = e.get("fidelity")
assert fidelity in ("analytical", "hybrid", "cycle-accurate"), \
    f"{required} bad fidelity: {fidelity}"
env = e.get("coverage_envelope") or {}
assert env.get("model_families"), f"{required} missing coverage_envelope.model_families"
last = e.get("last_seen_at")
assert last, f"{required} has no last_seen_at — heartbeat loop never fired"
ts = last.replace("Z", "+00:00")
ts = re.sub(r"\.(\d{1,6})([+-]\d\d:\d\d)$", lambda m: "." + m.group(1).ljust(6, "0") + m.group(2), ts)
seen = datetime.fromisoformat(ts)
age_s = (datetime.now(timezone.utc) - seen).total_seconds()
assert age_s < 90, f"{required} last_seen_at {age_s:.0f}s old — heartbeat stale"
print(f"  registered={sorted(by_name)}  heartbeat fresh")
'
ok   "  · surrogate registered + active + heartbeat fresh"

# ── 4/5 envelope-aware routing rejects out-of-coverage requests ──────
log "4/5 envelope coverage gating (out-of-coverage → 503 with misses)"
MISS_HTTP_CODE="$(curl -sS -o "$LOG_DIR/engines-step4-envelope-miss.json" -w '%{http_code}' \
  -X POST "$BFF/v1/engines/predict" \
  -H "$AUTH_HEADER" \
  -H "X-Project-ID: $PROJECT_ID" \
  -H 'content-type: application/json' \
  --data-raw '{"payload":{
      "cluster":{"gpu_model":"B200","gpu_count":1024},
      "model":{"family":"dlrm","weight_quant":"FP8",
                "activated_params_b":8.0,"total_params_b":8.0},
      "workload":{"mode":"training",
                   "seq_len":1024,"global_batch":128},
      "strategy":{"TP":4,"PP":2,"EP":1,"CP":1,
                   "recompute":"selective","overlap":"1F1B"}}}')"
MISS_BODY="$(cat "$LOG_DIR/engines-step4-envelope-miss.json")"
[ "$MISS_HTTP_CODE" = "503" ] || fail "expected 503, got $MISS_HTTP_CODE: $MISS_BODY"
assert_python "$MISS_BODY" '
import sys, json
d = json.loads(sys.argv[1])
def find_misses(obj):
    if isinstance(obj, dict):
        if "misses" in obj and isinstance(obj["misses"], dict):
            return obj["misses"]
        for v in obj.values():
            r = find_misses(v)
            if r is not None: return r
    return None
misses = find_misses(d) or {}
assert "surrogate-analytical" in misses, f"surrogate not in misses: {sorted(misses)} body={d}"
fields = {r["field"] for r in misses["surrogate-analytical"]}
assert "model_family" in fields, f"surrogate did not flag model_family: {fields}"
print(f"  503 with detailed misses for {sorted(misses)}; field=model_family flagged")
'
ok   "  · envelope-aware 503 with miss-reasons works"

# ── 5/5 auto-routing picks surrogate when no engine_preference ───────
log "5/5 auto-routing without engine_preference"
AUTO_RESPONSE="$(curl_auth POST "$BFF/v1/engines/predict" \
  '{"payload":{
      "cluster":{"gpu_model":"H200","gpu_count":8},
      "model":{"family":"transformer-dense","weight_quant":"FP8",
                "activated_params_b":8.0,"total_params_b":8.0},
      "workload":{"mode":"training",
                   "seq_len":2048,"global_batch":64},
      "strategy":{"TP":4,"PP":2,"EP":1,"CP":1,
                   "recompute":"selective","overlap":"1F1B"}
   }}')"
debug_dump "engines-step5-auto-route.json" "$AUTO_RESPONSE"
assert_python "$AUTO_RESPONSE" '
import sys, json
d = json.loads(sys.argv[1])
prov = d.get("_provenance") or {}
engine_name = prov.get("engine")
fidelity = prov.get("fidelity")
selected_by = prov.get("selected_by")
assert engine_name == "surrogate-analytical", \
    f"expected surrogate-analytical, got engine={engine_name} fidelity={fidelity}"
assert selected_by == "auto", f"expected selected_by=auto, got {selected_by}"
print(f"  auto-picked engine={engine_name} fidelity={fidelity}")
'
ok   "  · auto-routing picked surrogate-analytical"

ok "all 5 engine-layer stages passed"
