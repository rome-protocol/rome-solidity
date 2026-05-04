# Oracle Gateway V2 — Deploy Scripts

Deploy and ops scripts for the Oracle Gateway V2 stack: `PythPullAdapter`, `SwitchboardV3Adapter`, `OracleAdapterFactory`, `BatchReader`, and per-feed adapter clones.

**Read `contracts/oracle/README.md` first** (if present) for the architecture; this file is the operational companion.

## Scripts

- `deploy.ts` — original V1-era deploy. Deploys `PythPullAdapter` impl, `SwitchboardV3Adapter` impl, `OracleAdapterFactory`, and `BatchReader`. Override program IDs via `PYTH_PRICE_FEED_PROGRAM_ID`, `SWITCHBOARD_PROGRAM_ID`, `DEFAULT_MAX_STALENESS`.
- `deploy-v2-polish.ts` — current polished V2 deployer (post-audit, with staleness guards + `metadata()`). **Idempotent**: skips redeploy if `deployments/<network>.json` already has a populated `OracleGatewayV2` block. Set `FORCE_REDEPLOY=1` to override. Does **not** seed feeds.
- `deploy-seed-feeds.ts` — registers Pyth Pull + Switchboard V3 adapter clones against an already-deployed `OracleAdapterFactory`. Reads the factory address from `deployments/<network>.json`. Idempotent — skips pubkeys already registered.
- `deploy-factory.ts` — factory-only deploy.
- `deploy-and-test.ts` — end-to-end deploy + smoke test.

## Manual deploy flow

Deploys are run **manually from a maintainer's machine**, not via CI. The Hardhat keystore holds the per-network deployer key — values never leave the local box. Each deploy ends with a PR that commits the updated `deployments/<network>.json`.

### One-time keystore setup

Per network you intend to deploy to:

```bash
npx hardhat keystore set CHAIN_PRIVATE_KEY       # for rome (current devnet target)
npx hardhat keystore set LOCAL_PRIVATE_KEY --dev  # for local stack
```

Network ↔ keystore-var mapping lives in `hardhat.config.ts`. The `--dev` flag stores in plaintext (only for local stacks; never use `--dev` for live network keys).

### Deploy a fresh Oracle Gateway V2 stack

```bash
npx hardhat run scripts/oracle/deploy-v2-polish.ts --network <chain>
npx hardhat run scripts/oracle/deploy-seed-feeds.ts --network <chain>
git add deployments/rome.json
git commit -m "ops(oracle): deploy Oracle Gateway V2 to rome"
```

### Local stack (no keystore needed)

Requires `rome-setup/deploy/start-local.sh` running.

```bash
npx hardhat run scripts/oracle/deploy-v2-polish.ts --network local
npx hardhat run scripts/oracle/deploy-seed-feeds.ts --network local
```

## Why no CI deploy workflow

A `deploy-oracle.yml` GitHub Actions workflow existed briefly but never ran successfully — every Oracle deploy on every devnet has happened via the manual flow above. We removed the workflow and the associated `ROME_DEVNET_PRIVATE_KEY` secret because:

1. **`rome-solidity` is a public repository.** Storing a deployer private key in any form (org-level secret, repo-level secret, environment secret) widens the attack surface beyond what the manual local flow has.
2. **No engineer was using it.** Every Bridge / ERC20SPL / Meteora deploy already follows the manual pattern; the Oracle workflow was an outlier.
3. **No automation upside today.** Deploys are infrequent and require per-deploy judgement (which network, which feeds, idempotency check). Adding CI gating with a GitHub Environment + reviewer click would not save effort over the current flow.

If/when a future requirement justifies CI deploys (e.g., approaching mainnet, or formal audit-trail requirements), the right home is a dedicated **private** deploy-runner repo that checks out `rome-solidity` and runs these same scripts — with per-network deploy keys gated by GitHub Environments.

## Live-network validation scripts (non-deploying)

- `test-feeds.ts` — V1 Pyth feed health probe.
- `test-feeds-v2.ts` — V2 Pyth Pull + BatchReader health probe.
- `test-switchboard.ts` — Switchboard V3 feed health probe.
- `validate-pyth-pull-offsets.ts`, `validate-switchboard-offsets.ts` — re-validate parser offsets against live Solana accounts. Run before any parser change.
- `check-account-owner.ts`, `check-switchboard.ts` — debug/inspect Solana account state.
