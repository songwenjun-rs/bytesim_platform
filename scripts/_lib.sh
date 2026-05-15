# scripts/_lib.sh — shared bash helpers for the e2e + ops scripts.
# Sourced, not executed. Requires bash, curl, python3.
#
# Conventions:
#   * `log` writes a status line (stderr).  `ok` writes the green success.
#     `fail` writes red + exits non-zero.
#   * `curl_auth METHOD URL [BODY]` adds Authorization: Bearer ${JWT} when set,
#     and X-Project-ID: ${PROJECT_ID:-p_default}.  curl_json is the no-auth
#     variant for /v1/auth/login itself.
#   * `wait_for_url`, `wait_for_field`, `assert_python` are the async/JSON
#     building blocks the e2e script composes.
# shellcheck shell=bash

# colors only when stderr is a TTY (CI logs stay clean)
if [ -t 2 ]; then
  _C_BLUE=$'\033[34m'; _C_GREEN=$'\033[32m'; _C_RED=$'\033[31m'; _C_RESET=$'\033[0m'
else
  _C_BLUE=""; _C_GREEN=""; _C_RED=""; _C_RESET=""
fi

log()  { printf '%s[e2e]%s %s\n' "$_C_BLUE"  "$_C_RESET" "$*" >&2; }
ok()   { printf '%s[ok]%s  %s\n'  "$_C_GREEN" "$_C_RESET" "$*" >&2; }
fail() { printf '%s[FAIL]%s %s\n' "$_C_RED"   "$_C_RESET" "$*" >&2; exit 1; }

# curl_json METHOD URL [BODY] — no-auth, for /v1/auth/login.
curl_json() {
  local method="$1" url="$2" body="${3-}"
  if [ -n "$body" ]; then
    curl -sS --fail-with-body -X "$method" "$url" \
      -H 'content-type: application/json' \
      --data-raw "$body"
  else
    curl -sS --fail-with-body -X "$method" "$url"
  fi
}

# curl_auth METHOD URL [BODY] — with JWT + project header.
# Fails the script via `set -e` propagation if the response is non-2xx.
curl_auth() {
  local method="$1" url="$2" body="${3-}"
  local proj="${PROJECT_ID:-p_default}"
  local auth="${AUTH_HEADER:-}"
  if [ -z "$auth" ]; then
    fail "curl_auth called before AUTH_HEADER is set"
  fi
  if [ -n "$body" ]; then
    curl -sS --fail-with-body -X "$method" "$url" \
      -H "$auth" \
      -H "X-Project-ID: $proj" \
      -H 'content-type: application/json' \
      --data-raw "$body"
  else
    curl -sS --fail-with-body -X "$method" "$url" \
      -H "$auth" \
      -H "X-Project-ID: $proj"
  fi
}

# json_get JSON KEY — extract a top-level field via python3, returns "" if missing.
json_get() {
  python3 -c '
import sys, json
try:
    d = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)
v = d.get(sys.argv[2]) if isinstance(d, dict) else None
print("" if v is None else v)' "$1" "$2"
}

# wait_for_url URL TIMEOUT_S
# Polls until URL returns HTTP 200 or timeout. Used pre-auth (healthz).
wait_for_url() {
  local url="$1" timeout="${2:-60}"
  local deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -sS -o /dev/null -w '%{http_code}' "$url" 2>/dev/null | grep -q '^200$'; then
      return 0
    fi
    sleep 2
  done
  fail "timeout: $url did not return 200 within ${timeout}s"
}

# wait_for_field URL FIELD EXPECTED TIMEOUT_S
# Polls authenticated URL until the JSON top-level FIELD == EXPECTED. Used for
# study.status / run.status / calibration_job.status transitions.
wait_for_field() {
  local url="$1" field="$2" expected="$3" timeout="${4:-60}"
  local deadline=$(( $(date +%s) + timeout )) cur="" body=""
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if body="$(curl_auth GET "$url" 2>/dev/null)"; then
      cur="$(json_get "$body" "$field")"
      if [ "$cur" = "$expected" ]; then return 0; fi
      if [ "$cur" = "failed" ] && [ "$expected" != "failed" ]; then
        fail "$url: $field='failed' (wanted '$expected'). Body: $body"
      fi
    fi
    sleep 2
  done
  fail "timeout: $url $field='$cur' (wanted '$expected') after ${timeout}s. Last body: $body"
}

# assert_python JSON 'inline-py-script' — passes JSON as sys.argv[1].
# Script asserts via `assert ...`. AssertionError exits non-zero.
assert_python() {
  python3 -c "$2" "$1"
}
