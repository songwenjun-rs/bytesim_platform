#!/usr/bin/env bash
# scripts/e2e.sh — ByteSim end-to-end smoke test.
#
# Verifies one complete vertical slice:
#   login → snapshot HwSpec → run done
#   → engine registry (v2: self-register + heartbeat + envelope-aware routing)
#
# Exits 0 on success, non-zero on any failed assertion. Designed to run against
# a freshly-up `make up` stack (BFF on :8080) and to be the gating check in CI.
#
# Tunables (env):
#   BFF_URL            default http://localhost:8080
#   E2E_USER           default songwenjun (must be in services/bff/app/auth.py:USER_PROJECTS)
#   PROJECT_ID         default p_default
#   MAX_HEALTH_S       default 300
#   MAX_RUN_S          default 90

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/_lib.sh
source "$HERE/_lib.sh"

# Write key response bodies into LOG_DIR so e2e_ci.sh's artifact upload
# captures them — without this, when an assert fails we have no way to see
# what was returned (CI job log requires auth to download).
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
MAX_RUN_S="${MAX_RUN_S:-90}"

# ── 1/9 healthcheck ───────────────────────────────────────────────────
log "1/9 wait for BFF healthy at $BFF (max ${MAX_HEALTH_S}s)"
wait_for_url "$BFF/healthz" "$MAX_HEALTH_S"

# ── 2/9 login ─────────────────────────────────────────────────────────
log "2/9 login as $E2E_USER"
LOGIN_BODY="$(curl_json POST "$BFF/v1/auth/login" \
  "{\"user_id\":\"$E2E_USER\",\"password\":\"\"}")"
JWT="$(json_get "$LOGIN_BODY" token)"
[ -n "$JWT" ] || fail "login returned empty token: $LOGIN_BODY"
export AUTH_HEADER="Authorization: Bearer $JWT"
ok   "  · token acquired (len=${#JWT})"

# ── 3/9 snapshot HwSpec ───────────────────────────────────────────────
# Use a dedicated e2e spec id (NOT the user-facing hwspec_topo_b1) so the
# script never overwrites the cluster topology a real user is editing in
# the Topology page. asset-svc's id-prefix auto-create (`hwspec_*` →
# kind=hwspec) handles first-time row creation; subsequent runs append a
# new version onto the same dedicated spec row.
HWSPEC_ID="${E2E_HWSPEC_ID:-hwspec_e2e}"
log "3/9 save a fresh HwSpec snapshot to $HWSPEC_ID"
# Per-run timestamp keeps the body unique across e2e invocations:
# bs_spec_version's PK is `hash` alone, so identical bodies under a
# different spec_id collide on PK. Until asset-svc grows cross-spec
# dedup awareness, the cheapest way to make this script re-runnable
# is to vary one inert field. The frontend ignores the timestamp.
RUN_TS="$(date -u +%s)"
SNAP_BODY="{\"body\":{\"cluster\":\"e2e-test\",\"e2e_run_ts\":\"$RUN_TS\",\"datacenter\":{\"id\":\"e2e\",\"name\":\"e2e\",\"clusters\":[{\"id\":\"cl-e2e\",\"name\":\"e2e cluster\",\"racks\":[]}]},\"fabric\":{\"topology\":\"spine-leaf\",\"spines\":[],\"leaves\":[],\"links\":[]}}}"
SNAP_RESPONSE="$(curl_auth POST "$BFF/v1/specs/hwspec/$HWSPEC_ID/snapshot" "$SNAP_BODY")"
HWSPEC_HASH="$(json_get "$SNAP_RESPONSE" hash)"
[ -n "$HWSPEC_HASH" ] || fail "snapshot returned no hash: $SNAP_RESPONSE"
ok   "  · new HwSpec hash ${HWSPEC_HASH:0:12}…"

# ── 4/9 create Run with strategy override ─────────────────────────────
# Look the model hash up dynamically rather than hard-coding a seed value —
# any new spec snapshot bumps latest_hash, so the seeded "0000…0102" gets
# stale once the frontend / asset-svc bootstrap path runs once.
MODEL_RESPONSE="$(curl_auth GET "$BFF/v1/specs/model/model_moe256e")"
MODEL_HASH="$(python3 -c '
import sys, json
d = json.loads(sys.argv[1])
print((d.get("version") or {}).get("hash", ""))
' "$MODEL_RESPONSE")"
[ -n "$MODEL_HASH" ] || fail "no model hash in /v1/specs/model/model_moe256e response: $MODEL_RESPONSE"
ok   "  · model hash ${MODEL_HASH:0:12}…"
log "4/9 create Run with explicit strategy + engine pin (skips baseline+scan)"
# engine_preference pins the registry to a specific engine. The pipeline
# notices the pin and runs `_run_pinned` (single predict against that
# engine), skipping the 5-candidate scan. This makes the e2e run-time
# bounded by ONE surrogate-analytical predict (sub-sec) instead of 6.
RUN_RESPONSE="$(curl_auth POST "$BFF/v1/runs" \
  "{\"kind\":\"train\",\"title\":\"e2e\",\"hwspec_hash\":\"$HWSPEC_HASH\",\"model_hash\":\"$MODEL_HASH\",\"strategy_override\":{\"TP\":4,\"PP\":2,\"EP\":1,\"CP\":1,\"recompute\":\"selective\",\"overlap\":\"1F1B\"},\"engine_preference\":\"surrogate-analytical\",\"created_by\":\"e2e\"}")"
RUN_ID="$(json_get "$RUN_RESPONSE" id)"
[ -n "$RUN_ID" ] || fail "no run id: $RUN_RESPONSE"
ok   "  · RUN=$RUN_ID"

# ── 5/9 wait for Run completion ───────────────────────────────────────
log "5/9 wait for Run to complete (max ${MAX_RUN_S}s)"
wait_for_field "$BFF/v1/runs/$RUN_ID" status done "$MAX_RUN_S"
ok   "  · run done"

# ── 6/9 assert KPIs + artifacts (data path v2: /report) ──────────────
log "6/9 assert KPIs + ≥4 artifacts"
RUN_REPORT="$(curl_auth GET "$BFF/v1/runs/$RUN_ID/report")"
debug_dump "step6-run-report.json" "$RUN_REPORT"
assert_python "$RUN_REPORT" '
import sys, json
d = json.loads(sys.argv[1])
# P3.1: /report payload — predict (perf engine) lives under
# d["predict"]["response"], TCO under d["tco"]["response"], artifacts at
# the top level. Pre-v2 this was d["run"]["kpis"] / d["run"]["artifacts"].
predict = d.get("predict") or {}
resp = predict.get("response") or {}
mfu = resp.get("mfu_pct")
assert mfu is not None and 10 <= mfu <= 65, f"MFU out of range: {mfu}"
arts = d.get("artifacts") or []
names = [a.get("name") for a in arts]
assert len(arts) >= 4, f"expected >=4 artifacts, got {len(arts)}: {names}"
eng = (predict.get("engine") or {}).get("name")
print(f"  MFU={mfu}%  artifacts={len(arts)}  engine={eng}")
'
ok   "  · KPI assertions passed"

# ── 7/8 engine registry visibility + heartbeat freshness ──────────────
# RFC-001 v2 §2.6 self-registration. surrogate-analytical is the only engine
# the platform ships with by default.
log "7/8 engine registry self-registration + heartbeat"
ENGINES_BODY="$(curl_auth GET "$BFF/v1/engines")"
debug_dump "step7-engines.json" "$ENGINES_BODY"
assert_python "$ENGINES_BODY" '
import sys, json
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
seen = datetime.fromisoformat(last.replace("Z", "+00:00"))
age_s = (datetime.now(timezone.utc) - seen).total_seconds()
assert age_s < 90, f"{required} last_seen_at {age_s:.0f}s old — heartbeat stale"
print(f"  registered={sorted(by_name)}  heartbeat fresh")
'
ok   "  · surrogate registered + active + heartbeat fresh"

# ── 8/8 envelope coverage gating ──────────────────────────────────────
# `dlrm` is outside surrogate's transformer-only model_families list; the
# registry must surface a 503 with miss-reasons rather than route blindly.
log "8/8 envelope coverage gating (out-of-coverage → 503 with misses)"
MISS_HTTP_CODE="$(curl -sS -o /tmp/e2e-step8.json -w '%{http_code}' \
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
MISS_BODY="$(cat /tmp/e2e-step8.json)"
debug_dump "step8-envelope-miss.json" "$MISS_BODY"
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

ok "all 8 stages passed"
