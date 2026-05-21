#!/bin/bash
# update-registry-from-deploy.sh
#
# Manual operator flow for syncing the registry's oracle.json + contracts.json
# entries after an oracle-deploy.yml run merges its rome-solidity PR-back.
#
# This script runs locally — it doesn't need the rome-deploys GitHub App to
# have access to the registry repo. It uses your local checkouts + your
# personal `gh` auth to open the registry PR.
#
# Why this exists: the auto-PR-to-registry step (contract-deploys #18) was
# reverted in #20 because the rome-deploys App lacks read access on the
# registry repo. Until that's resolved, run THIS script after each oracle
# deploy to keep registry/<chain>/oracle.json + contracts.json in sync.
#
# Usage:
#   ./scripts/oracle/update-registry-from-deploy.sh <network> [<registry-path>]
#
# Args:
#   <network>        — hardhat network name (e.g. hadrian, marcus, aurelius)
#   <registry-path>  — optional; path to your local rome-protocol/registry
#                      checkout. Defaults to ../registry from the rome-solidity
#                      root.
#
# Prerequisites:
#   - You have a local checkout of rome-protocol/registry at <registry-path>
#   - Your current rome-solidity checkout is at master with the latest
#     deployments/<network>.json
#   - `gh` is authenticated with rights to open PRs on rome-protocol/registry
#
# Side effects:
#   - Pulls latest main on your registry checkout
#   - Creates a new branch `auto-update-<network>-<unix-ts>` on the registry
#   - Runs emit-registry-update-cli.ts to write the updated files
#   - Commits the changes
#   - Pushes the branch + opens a PR via `gh pr create`
#   - Does NOT merge — operator reviews the diff then merges via the GitHub UI

set -euo pipefail

NETWORK="${1:?usage: $0 <network> [<registry-path>]}"
REGISTRY_PATH="${2:-$(dirname "$0")/../../../registry}"

ROME_SOLIDITY_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REGISTRY_PATH="$(cd "$REGISTRY_PATH" && pwd)"

DEPLOYMENTS_FILE="$ROME_SOLIDITY_ROOT/deployments/${NETWORK}.json"
if [[ ! -f "$DEPLOYMENTS_FILE" ]]; then
  echo "error: deployments file not found at $DEPLOYMENTS_FILE" >&2
  echo "  pull latest rome-solidity master first; the post-deploy PR-back" >&2
  echo "  should have updated this file." >&2
  exit 1
fi

if [[ ! -d "$REGISTRY_PATH/chains" ]]; then
  echo "error: registry checkout not found at $REGISTRY_PATH" >&2
  echo "  expected to find a 'chains/' subdir; pass <registry-path> as arg 2" >&2
  exit 1
fi

SOURCE_SHA="$(cd "$ROME_SOLIDITY_ROOT" && git rev-parse HEAD)"
SHORT_SHA="${SOURCE_SHA:0:8}"
TS="$(date +%s)"
BRANCH="auto-update-${NETWORK}-${TS}"

echo "[*] rome-solidity root:  $ROME_SOLIDITY_ROOT"
echo "[*] registry path:       $REGISTRY_PATH"
echo "[*] deployments file:    $DEPLOYMENTS_FILE"
echo "[*] source SHA:          $SOURCE_SHA"
echo "[*] new branch:          $BRANCH"
echo

cd "$REGISTRY_PATH"
echo "[*] pulling latest registry main..."
git fetch origin main --quiet
git checkout -b "$BRANCH" origin/main

echo "[*] running emit-registry-update-cli.ts..."
npx tsx "$ROME_SOLIDITY_ROOT/scripts/oracle/emit-registry-update-cli.ts" \
  --network "$NETWORK" \
  --registry-path . \
  --source-git-sha "$SOURCE_SHA" \
  --deployments-path "$DEPLOYMENTS_FILE"

echo
echo "[*] file changes:"
git status --short chains/

if git diff --quiet chains/; then
  echo "[*] no changes — registry is already up to date"
  git checkout main
  git branch -D "$BRANCH"
  exit 0
fi

echo
echo "[*] staging + committing..."
git add chains/*/oracle.json chains/*/contracts.json
git commit -m "ops(oracle): update ${NETWORK} registry oracle wiring (rome-solidity@${SHORT_SHA})

Auto-generated from rome-solidity/deployments/${NETWORK}.json via
scripts/oracle/update-registry-from-deploy.sh.

Source SHA: ${SOURCE_SHA}
"

echo "[*] pushing branch..."
git push -u origin "$BRANCH"

echo "[*] opening PR..."
gh pr create \
  --base main \
  --head "$BRANCH" \
  --title "ops(oracle): update ${NETWORK} registry oracle wiring (rome-solidity@${SHORT_SHA})" \
  --body "Auto-generated registry update from a recent oracle deploy on \`${NETWORK}\`.

Updated files reflect \`rome-solidity/deployments/${NETWORK}.json\` at SHA \`${SOURCE_SHA}\`.

## Verification

After merging this PR, the registry liveness probe will run on the next push to main and probe each adapter address via \`latestRoundData()\` — proving the addresses respond on-chain.

## When auto-PR is restored

This manual flow is a stop-gap. The auto-PR-to-registry step was reverted in [contract-deploys #20](https://github.com/rome-protocol/contract-deploys/pull/20) pending GitHub App permission setup. When the \`rome-deploys\` App gets read access on this repo, the auto-flow can be re-enabled and this script becomes unnecessary.
"

echo
echo "[✓] done."
