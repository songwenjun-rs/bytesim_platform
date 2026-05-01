#!/usr/bin/env bash
# scripts/e2e_engines.sh — engine-layer-only smoke (RFC-001 v2 + RFC-003).
#
# Six stages: health → login → registry visibility → astra-sim chakra round-trip
# → envelope-miss 503 → auto-routing tiebreaker. The same assertions live in
# scripts/e2e.sh stages 14-17; this script lifts them out so engine-layer
# changes can be validated in seconds without re-running the full 17-stage
# tuner/calibration loop.
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

# ── 1/6 healthcheck ──────────────────────────────────────────────────
log "1/6 wait for BFF healthy at $BFF (max ${MAX_HEALTH_S}s)"
wait_for_url "$BFF/healthz" "$MAX_HEALTH_S"

# ── 2/6 login ────────────────────────────────────────────────────────
log "2/6 login as $E2E_USER"
LOGIN_BODY="$(curl_json POST "$BFF/v1/auth/login" \
  "{\"user_id\":\"$E2E_USER\",\"password\":\"\"}")"
JWT="$(json_get "$LOGIN_BODY" token)"
[ -n "$JWT" ] || fail "login returned empty token: $LOGIN_BODY"
export AUTH_HEADER="Authorization: Bearer $JWT"
ok   "  · token acquired (len=${#JWT})"

# ── 3/6 engine registry visibility + heartbeat freshness ─────────────
log "3/6 engine registry self-registration + heartbeat"
ENGINES_BODY="$(curl_auth GET "$BFF/v1/engines")"
debug_dump "engines-step3-engines.json" "$ENGINES_BODY"
assert_python "$ENGINES_BODY" '
import sys, json
from datetime import datetime, timezone
engines = json.loads(sys.argv[1])
by_name = {e["name"]: e for e in engines}
for required in ("surrogate-analytical", "astra-sim"):
    assert required in by_name, f"engine {required} not registered: {sorted(by_name)}"
    e = by_name[required]
    status = e["status"]
    assert status == "active", f"{required} status={status} (expected active)"
    fidelity = e.get("fidelity")
    assert fidelity in ("analytical", "hybrid", "cycle-accurate"), \
        f"{required} bad fidelity: {fidelity}"
    env = e.get("coverage_envelope") or {}
    assert env.get("workload_families"), f"{required} missing coverage_envelope.workload_families"
    last = e.get("last_seen_at")
    assert last, f"{required} has no last_seen_at — heartbeat loop never fired"
    seen = datetime.fromisoformat(last.replace("Z", "+00:00"))
    age_s = (datetime.now(timezone.utc) - seen).total_seconds()
    assert age_s < 90, f"{required} last_seen_at {age_s:.0f}s old — heartbeat stale"
print(f"  registered={sorted(by_name)}  all heartbeats fresh")
'
ok   "  · both engines registered + active + heartbeats fresh"

# ── 4/6 astra-sim end-to-end via chakra writer ───────────────────────
log "4/6 astra-sim end-to-end via chakra writer (v2 + RFC-003)"
ASTRA_RESPONSE="$(curl_auth POST "$BFF/v1/engines/predict" \
  '{"engine_preference":"astra-sim","payload":{
      "cluster":{"gpu_model":"H200","gpu_count":8,
                 "electricity_usd_per_kwh":0.092,"pue":1.18,
                 "fabric_topology":[
                   {"id":"L0","src_id":"a","dst_id":"b","fabric":"infiniband","bw_gbps":400}
                 ]},
      "workload":{"workload_family":"transformer-dense","mode":"training",
                   "seq_len":2048,"global_batch":64,
                   "activated_params_b":8.0,"total_params_b":8.0,"quant":"FP8"},
      "strategy":{"TP":4,"PP":2,"EP":1,"CP":1,
                   "recompute":"selective","overlap":"1F1B"}
   }}')"
debug_dump "engines-step4-astra-predict.json" "$ASTRA_RESPONSE"
assert_python "$ASTRA_RESPONSE" '
import sys, json
d = json.loads(sys.argv[1])
prov = d.get("_provenance") or {}
assert prov.get("engine") == "astra-sim", \
    "expected astra-sim in provenance, got " + repr(prov)
assert prov.get("fidelity") == "cycle-accurate", \
    "expected cycle-accurate fidelity, got " + repr(prov)
assert prov.get("selected_by") == "engine_preference", \
    "expected selected_by=engine_preference, got " + repr(prov)
assert prov.get("coverage_status") == "in_dist", \
    "expected coverage_status=in_dist, got " + repr(prov)
mfu = d.get("mfu_pct")
assert mfu and mfu > 0, "missing/zero mfu_pct: " + repr(d)
step = d.get("step_ms")
assert step and step > 0, "missing/zero step_ms: " + repr(d)
bd = d.get("breakdown") or {}
for k in ("compute_ms", "comm_ms", "mem_stall_ms", "idle_ms"):
    assert k in bd, f"missing breakdown.{k}: {bd}"
notes = " ".join(d.get("notes") or [])
assert "chakra" in notes.lower() or "trace_prefix" in notes, \
    "notes missing chakra evidence: " + repr(d.get("notes"))
# Locals to dodge bash single-quote nesting (see e2e.sh stage 15 comment).
engine_name = prov.get("engine")
compute_ms = bd.get("compute_ms")
comm_ms = bd.get("comm_ms")
print(f"  engine={engine_name} mfu={mfu}% step={step}ms "
      f"compute={compute_ms}ms comm={comm_ms}ms")
'
ok   "  · astra-sim chakra trace round-trip succeeded"

# ── 5/6 envelope-aware routing rejects out-of-coverage requests ──────
log "5/6 envelope coverage gating (out-of-coverage → 503 with misses)"
MISS_HTTP_CODE="$(curl -sS -o "$LOG_DIR/engines-step5-envelope-miss.json" -w '%{http_code}' \
  -X POST "$BFF/v1/engines/predict" \
  -H "$AUTH_HEADER" \
  -H "X-Project-ID: $PROJECT_ID" \
  -H 'content-type: application/json' \
  --data-raw '{"payload":{
      "cluster":{"gpu_model":"B200","gpu_count":1024},
      "workload":{"workload_family":"dlrm","mode":"training",
                   "seq_len":1024,"global_batch":128,
                   "activated_params_b":8.0,"total_params_b":8.0,"quant":"FP8"},
      "strategy":{"TP":4,"PP":2,"EP":1,"CP":1,
                   "recompute":"selective","overlap":"1F1B"}}}')"
MISS_BODY="$(cat "$LOG_DIR/engines-step5-envelope-miss.json")"
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
assert "astra-sim" in misses, f"astra not in misses: {sorted(misses)} body={d}"
for engine, reasons in misses.items():
    fields = {r["field"] for r in reasons}
    assert "workload_family" in fields, f"{engine} did not flag workload_family: {fields}"
print(f"  503 with detailed misses for {sorted(misses)}; field=workload_family flagged on both")
'
ok   "  · envelope-aware 503 with miss-reasons works"

# ── 6/6 envelope-aware auto-routing picks the right engine ───────────
log "6/6 auto-routing prefers higher-fidelity engine"
AUTO_RESPONSE="$(curl_auth POST "$BFF/v1/engines/predict" \
  '{"payload":{
      "cluster":{"gpu_model":"H200","gpu_count":8},
      "workload":{"workload_family":"transformer-dense","mode":"training",
                   "seq_len":2048,"global_batch":64,
                   "activated_params_b":8.0,"total_params_b":8.0,"quant":"FP8"},
      "strategy":{"TP":4,"PP":2,"EP":1,"CP":1,
                   "recompute":"selective","overlap":"1F1B"}
   }}')"
debug_dump "engines-step6-auto-route.json" "$AUTO_RESPONSE"
assert_python "$AUTO_RESPONSE" '
import sys, json
d = json.loads(sys.argv[1])
prov = d.get("_provenance") or {}
engine_name = prov.get("engine")
fidelity = prov.get("fidelity")
selected_by = prov.get("selected_by")
latency_ms = prov.get("latency_ms")
assert engine_name == "astra-sim", \
    f"auto-routing should pick higher-fidelity (astra-sim cycle-accurate) " \
    f"over surrogate-analytical for in-envelope requests; got engine={engine_name} " \
    f"fidelity={fidelity}"
assert selected_by == "auto", \
    f"expected selected_by=auto, got {selected_by}"
print(f"  auto-picked engine={engine_name} fidelity={fidelity} "
      f"latency_ms={latency_ms}")
'
ok   "  · auto-routing picked higher-fidelity engine"

ok "all 6 engine-layer stages passed"
