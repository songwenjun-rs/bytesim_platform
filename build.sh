#!/usr/bin/env bash
# Platform-wide one-shot build orchestrator.
#
# Iterates each submodule and runs its own build.sh. Each submodule writes
# its artifacts to its own ./output/; this script collects nothing locally
# — just runs them in dependency order and reports per-repo status.
#
# Skips submodules whose build.sh detects missing prereqs (e.g. bytesim_svc
# when ByteSim engine assets aren't populated).
#
# Usage:
#   ./build.sh                # build everything (contracts → backend → web)
#   ./build.sh data_svc bff   # build only the named submodules

set -euo pipefail
cd "$(dirname "$0")"

# Order: contracts first (downstream may regen), then services, then web.
ALL=(
  "engine_contracts"
  "service/data_svc"
  "bff"
  "service/engine_svc"
  "service/surrogate_svc"
  "service/bytesim_svc"
  "service/tco_svc"
  "dashboard"
)

# Filter to caller-requested subset (match by basename)
if (( $# > 0 )); then
  selected=()
  for arg in "$@"; do
    for path in "${ALL[@]}"; do
      [[ "$(basename "$path")" == "$arg" ]] && selected+=("$path")
    done
  done
  if (( ${#selected[@]} == 0 )); then
    echo "no matching submodules for: $*" >&2
    echo "known: $(printf '%s ' "${ALL[@]}" | xargs -n1 basename | tr '\n' ' ')" >&2
    exit 2
  fi
  TARGETS=("${selected[@]}")
else
  TARGETS=("${ALL[@]}")
fi

declare -a OK SKIP FAIL

for repo in "${TARGETS[@]}"; do
  echo ""
  echo "============================================================"
  echo "  BUILD: $repo"
  echo "============================================================"
  if [[ ! -x "$repo/build.sh" ]]; then
    echo "  no build.sh — skipping"
    SKIP+=("$repo")
    continue
  fi
  if ( cd "$repo" && ./build.sh ); then
    OK+=("$repo")
  else
    FAIL+=("$repo")
    echo "  FAILED: $repo"
  fi
done

echo ""
echo "============================================================"
echo "  SUMMARY"
echo "============================================================"
printf "  ok:    %s\n" "${#OK[@]}"
for r in "${OK[@]:-}"; do echo "    · $r"; done
printf "  skip:  %s\n" "${#SKIP[@]}"
for r in "${SKIP[@]:-}"; do echo "    · $r"; done
printf "  fail:  %s\n" "${#FAIL[@]}"
for r in "${FAIL[@]:-}"; do echo "    · $r"; done

(( ${#FAIL[@]} == 0 ))
