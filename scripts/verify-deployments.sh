#!/usr/bin/env bash
# Verify every deployed address recorded for a network, and say what it could not do.
#
# Why this exists: verification was manual, so coverage depended on who remembered.
# Measured on Hadrian before this: 35 of 42 registry contracts verified, and the
# seven gaps were almost all one deploy's worth of oracle adapters — the signature
# of a step someone skipped, not of a system that cannot verify.
#
# Advisory by design. It exits 0 even when some contracts cannot be verified, so a
# deploy is never failed by a verification quirk; the summary names what needs a
# human. Two quirks are expected and are NOT failures of this script:
#
#   HHE80010  the bytecode matches more than one contract (a harness alongside the
#             real one) — needs --contract <path>:<Name>.
#   HHE80018  the constructor takes arguments — needs --constructor-args-path, and
#             the values are not in the deployments manifest.
#
# A third case is a real dead end: HHE80009, bytecode matching nothing in the
# current source, which means the deployment predates a source change and today's
# code cannot reproduce it. Verifying AT DEPLOY TIME is the only fix for that, which
# is the point of calling this from the deploy workflow rather than by hand later.
#
# Usage: scripts/verify-deployments.sh <network>        # e.g. hadrian
set -uo pipefail

NET="${1:-}"
[[ -n "$NET" ]] || { echo "usage: $0 <network>  (a hardhat network name)"; exit 2; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/deployments/$NET.json"
[[ -f "$MANIFEST" ]] || { echo "no deployments manifest for '$NET' at $MANIFEST"; exit 2; }

# Read the chain id and verifier straight out of hardhat.config.ts, so this script
# cannot drift from what `hardhat verify` actually talks to. Both are single literals
# there; a miss is loud rather than silent.
CHAIN_ID="$(grep -A4 "^    $NET: {" "$ROOT/hardhat.config.ts" | grep -oE 'chainId: [0-9]+' | grep -oE '[0-9]+' | head -1)"
VERIFIER="$(grep -oE 'apiUrl: "[^"]+"' "$ROOT/hardhat.config.ts" | head -1 | sed 's/.*"\(.*\)"/\1/')"
[[ -n "$CHAIN_ID" && -n "$VERIFIER" ]] || { echo "could not read chainId/apiUrl for '$NET' from hardhat.config.ts"; exit 2; }

echo "network $NET (chain $CHAIN_ID) → $VERIFIER"

# A read loop rather than mapfile: macOS ships bash 3.2, which has no mapfile, and a
# script that only works on the CI runner is a script nobody can check locally.
ADDRS=()
while IFS= read -r _a; do [[ -n "$_a" ]] && ADDRS+=("$_a"); done < <(python3 - "$MANIFEST" <<'PY'

import json, re, sys
seen, out = set(), []
def walk(o):
    if isinstance(o, dict):
        for v in o.values(): walk(v)
    elif isinstance(o, list):
        for v in o: walk(v)
    elif isinstance(o, str) and re.fullmatch(r"0x[0-9a-fA-F]{40}", o):
        k = o.lower()
        if k not in seen:
            seen.add(k); out.append(o)
walk(json.load(open(sys.argv[1])))
print("\n".join(out))
PY
)

already=0; verified=0; needs_help=0; drifted=0; foreign=0
ATTENTION=()

for addr in "${ADDRS[@]}"; do
  # Retry the pre-check once: a single timeout otherwise reclassifies an already
  # verified contract as a gap, and the summary changes between runs for no reason.
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$VERIFIER/v2/contract/$CHAIN_ID/$addr")"
  [[ "$code" == "200" ]] || code="$(curl -s -o /dev/null -w '%{http_code}' -m 30 "$VERIFIER/v2/contract/$CHAIN_ID/$addr")"
  if [[ "$code" == "200" ]]; then
    already=$((already + 1)); continue
  fi
  out="$(cd "$ROOT" && npx hardhat verify --network "$NET" "$addr" 2>&1)"
  if grep -q "verified successfully" <<<"$out"; then
    verified=$((verified + 1)); echo "  verified $addr"
  elif grep -q "HHE80010" <<<"$out"; then
    needs_help=$((needs_help + 1)); ATTENTION+=("$addr needs --contract (bytecode matches several)")
  elif grep -q "HHE80018" <<<"$out"; then
    needs_help=$((needs_help + 1)); ATTENTION+=("$addr needs --constructor-args-path")
  elif grep -qE "HHE80005|HHE80004" <<<"$out"; then
    # HHE80005 "compiled with Solidity <0.4.7" means the address carries no solc
    # metadata, and HHE80004 means no bytecode at all — a Rome precompile handle.
    # Either way it is
    # not a contract this project compiled. The manifest records plenty of those,
    # and counting them as gaps would make the summary useless.
    foreign=$((foreign + 1))
  elif grep -q "HHE80009" <<<"$out"; then
    drifted=$((drifted + 1)); ATTENTION+=("$addr bytecode matches nothing in current source — deployed before a source change")
  else
    needs_help=$((needs_help + 1)); ATTENTION+=("$addr $(grep -oE 'HHE[0-9]+.*' <<<"$out" | head -1)")
  fi
done

echo
echo "of ${#ADDRS[@]} addresses in the manifest:"
echo "  already verified $already · newly verified $verified · need a human $needs_help · drifted $drifted · not this project's $foreign"
if (( ${#ATTENTION[@]} > 0 )); then
  for line in "${ATTENTION[@]}"; do echo "  · $line"; done
fi
exit 0
