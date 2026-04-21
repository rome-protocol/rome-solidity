# Rome Bridge Phase 1 — Deploy Scripts

Deploy and ops scripts for the Rome Bridge contracts: paymaster, SPL_ERC20 wrappers (rUSDC, rETH), and withdraw.

**Read `contracts/bridge/README.md` first** — it covers the architecture, the four bridge flows, and the non-obvious problems that shaped the design (single-tx compute-budget limit, missing SPL Approve, stale canonical mints, etc.). This file is the operational companion.

## Deploy scripts

- `constants.ts` — canonical Solana program IDs (mainnet + devnet), SPL mint pubkeys, CCTP domains, Wormhole chain IDs. `SPL_MINTS_DEVNET.WETH_WORMHOLE` must match the canonical wrapped-ETH mint for the Ethereum chain you are bridging from.
- `deploy.ts` — one-shot fresh deploy: paymaster + SPL_ERC20 (rUSDC, rETH) + withdraw. Allowlists `burnUSDC` and `burnETH` on the paymaster. Writes to `deployments/{network}.json`.
- `redeploy-withdraw-devnet-wh.ts` — redeploy only the withdraw contract against devnet Wormhole programs; reuses paymaster + wrappers.
- `redeploy-withdraw-canonical-weth.ts` — redeploy withdraw + new rETH wrapper bound to the canonical wrapped-ETH mint (used when refreshing on a chain where the rETH wrapper still points at a stale mint).
- `redeploy-withdraw-only.ts` — redeploy withdraw with mainnet Wormhole programs (production path).
- `allowlist-approve-selector.ts` — run after any withdraw redeploy; allowlists `approveBurnETH(uint256)` on the paymaster so ERC-2771 sponsorship works for the two-step outbound Wh flow.
- `derive/cctp-accounts.ts` — derives the 6 CCTP PDAs via `PublicKey.findProgramAddressSync`.
- `derive/wormhole-accounts.ts` — derives the 8 Wormhole PDAs (including `wrappedMeta`, which is per-mint).
- `lib/canonical-mint.ts` — derives the canonical wrapped-ETH mint from `(tokenChain, tokenAddress, tokenBridgeProgramId)` per Wormhole's seed scheme. Always use this to resolve the wETH mint rather than hard-coding.
- `lib/verify-mint-on-chain.ts` — verifies the derived mint exists on Solana.

## Flow / test scripts

- `submit-burn.ts` — outbound CCTP: single `burnUSDC(amount, ethRecipient)` tx on Rome.
- `submit-burnETH.ts` — outbound Wormhole E2E: sends `approveBurnETH(amount)` then `burnETH(amount, ethRecipient)` in sequence. Requires two EVM txs (see `contracts/bridge/README.md` § "Two CPIs in a single Rome EVM transaction exceed Solana's compute budget").
- `smoke-emulate-all.ts` — quick `rome_emulateTx` health check for `burnUSDC` and `approveBurnETH`. `burnETH` is skipped because it requires a prior on-chain approve to emulate cleanly.
- `inbound/` — scripts for Sepolia → Rome inbound flows (CCTP deposit, Wormhole transfer, manual VAA complete).
- `do-full-test.ts`, `try-burn.ts`, `smoke-test-canonical.ts` — legacy integration helpers used during initial bring-up; kept for reference.

## Usage

### Local

Requires `rome-setup/deploy/start-local.sh` running. CCTP + Wormhole programs must be present in the local Solana cluster (they're seeded by rome-setup; if you see deploy errors referencing unknown programs, verify your local stack seeded them).

```bash
npx hardhat keystore set LOCAL_PRIVATE_KEY --dev
npx hardhat run scripts/bridge/deploy.ts --network local
```

### monti_spl devnet

```bash
npx hardhat keystore set MONTI_SPL_PRIVATE_KEY
npx hardhat run scripts/bridge/deploy.ts --network monti_spl
git add deployments/monti_spl.json
git commit -m "chore(bridge): record monti_spl devnet deployments"
```

## Testing

Unit tests (run on hardhatMainnet, no Rome stack needed):

```bash
npx hardhat test tests/bridge/RomeBridgePaymaster.test.ts --network hardhatMainnet
npx hardhat test tests/bridge/RomeBridgeWithdraw.test.ts --network hardhatMainnet
npx hardhat test tests/bridge/derive.test.ts --network hardhatMainnet
```

Integration tests (require live Rome stack + pre-seeded user balances):

```bash
npx hardhat test tests/bridge/RomeBridgeWithdraw.integration.ts --network local
# or
npx hardhat test tests/bridge/RomeBridgeWithdraw.integration.ts --network monti_spl
```

## Adding a new asset

1. Add the mint base58 to `constants.ts` under `SPL_MINTS`.
2. Add a `deploySplErc20` call in `main()` for the new symbol.
3. Extend `RomeBridgeWithdraw` with a new `burnXYZ` entry point that CPI-invokes the right Solana program (Wormhole or CCTP).
4. Register the new selector via `RomeBridgePaymaster.setAllowlistEntry`.

## Verifying PDA derivations

Both CCTP and Wormhole programs publish their seed schemes. Before first deploy on a new cluster, cross-check each PDA in `derive/*.ts` against:

- CCTP IDL: https://developers.circle.com/stablecoins/docs/cctp-on-solana
- Wormhole Token Bridge IDL: https://github.com/wormhole-foundation/wormhole/blob/main/solana/modules/token_bridge/idl

The 14 PDAs derived (6 CCTP + 8 Wormhole) are deterministic given the program IDs and the mint. Deterministic test coverage lives in `tests/bridge/derive.test.ts`.
