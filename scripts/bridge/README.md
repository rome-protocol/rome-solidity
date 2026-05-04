# Rome Bridge — Deploy Scripts

Deploy and ops scripts for the Rome Bridge contracts: paymaster (legacy), SPL_ERC20 wrappers (`WUSDC`, `WETH`, `WSOL`, plus per-asset `W{Symbol}` deploys), and `RomeBridgeWithdraw`.

Token nomenclature follows the canonical W-prefix standard documented in [`/CLAUDE.md` § "Token nomenclature"](../../CLAUDE.md#token-nomenclature--canonical-repo-wide).

**Read `contracts/bridge/README.md` first** — it covers the architecture, the four bridge flows, and the non-obvious problems that shaped the design (single-tx compute-budget limit, missing SPL Approve, stale canonical mints, etc.). This file is the operational companion.

## Deploy scripts

- `constants.ts` — canonical Solana program IDs (mainnet + devnet), SPL mint pubkeys, CCTP domains, Wormhole chain IDs. `SPL_MINTS_DEVNET.WETH_WORMHOLE` must match the canonical wrapped-ETH mint for the Ethereum chain you are bridging from.
- `deploy.ts` — one-shot fresh deploy: paymaster + SPL_ERC20 (WUSDC, WETH) + withdraw. Allowlists `burnUSDC` and `burnETH` on the paymaster. Writes to `deployments/{network}.json`.
- `redeploy-withdraw-devnet-wh.ts` — redeploy only the withdraw contract against devnet Wormhole programs; reuses paymaster + wrappers.
- `redeploy-withdraw-canonical-weth.ts` — redeploy withdraw + new WETH wrapper bound to the canonical wrapped-ETH mint (used when refreshing on a chain where the WETH wrapper still points at a stale mint).
- `redeploy-withdraw-only.ts` — redeploy withdraw with mainnet Wormhole programs (production path).
- `allowlist-approve-selector.ts` — run after any withdraw redeploy; allowlists `approveBurnETH(uint256)` on the paymaster so ERC-2771 sponsorship works for the two-step outbound Wh flow.
- `deploy-weth-v9.ts`, `deploy-wsol-v9.ts` — minimal SPL_ERC20 wrapper redeploys carrying the v9 outbound surface (`bridgeOutToSolana` + `ensureRecipientAta` + `balanceOf` reads from AUTHORITY_PDA). Use these to refresh wrappers on a chain after the contract upgrade. They do not touch the factory or paymaster.
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
# or against the live devnet
npx hardhat test tests/bridge/RomeBridgeWithdraw.integration.ts --network <chain>
```

## Adding a new asset

The path differs by asset origin:

### Solana-native SPL (any token deployed via the factory) — outbound only

For tokens that originate on Solana (USDT-on-Solana, JUP, BONK, custom long-tail, etc.), you only need an `SPL_ERC20` wrapper on Rome. No `RomeBridgeWithdraw` change, no new burn entrypoint, no paymaster allowlist update — `SPL_ERC20.bridgeOutToSolana` is the generic outbound for all of them.

1. Call `ERC20SPLFactory.add_spl_token_no_metadata(mint, "Symbol", "Name")` against the deployed factory on the target chain.
2. The backend's `TokenCreated` event indexer picks up the new wrapper and surfaces it in `rome-ui`'s portfolio + bridge picker. The bridge picker auto-includes it because `useRomeHoldings` filters on `kind === "wrap"`.

That's it. One CPI per outbound transfer, same code path as WETH/WSOL today.

### Ethereum-origin asset — inbound + outbound, requires Solidity work

For tokens that originate on Ethereum (USDC, ETH, future ERC20s reaching Rome through CCTP/Wormhole), the outbound path needs a per-asset entry on `RomeBridgeWithdraw`:

1. Add the mint base58 to `constants.ts` under `SPL_MINTS`.
2. Add a `deploySplErc20` call in `main()` for the new symbol.
3. Extend `RomeBridgeWithdraw` with a new `burnXYZ` entry point that CPI-invokes the right Solana program (Wormhole or CCTP).
4. Register the new selector via `RomeBridgePaymaster.setAllowlistEntry`.
5. Inbound side: ensure a Wormhole attestation exists between the source chain and the target Solana cluster (one-time `attestToken` + `create_wrapped`). For CCTP, no attestation is needed — Circle handles all USDC.

## Verifying PDA derivations

Both CCTP and Wormhole programs publish their seed schemes. Before first deploy on a new cluster, cross-check each PDA in `derive/*.ts` against:

- CCTP IDL: https://developers.circle.com/stablecoins/docs/cctp-on-solana
- Wormhole Token Bridge IDL: https://github.com/wormhole-foundation/wormhole/blob/main/solana/modules/token_bridge/idl

The 14 PDAs derived (6 CCTP + 8 Wormhole) are deterministic given the program IDs and the mint. Deterministic test coverage lives in `tests/bridge/derive.test.ts`.
