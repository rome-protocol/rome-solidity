# Rome Bridge — Deploy Scripts

Deploy and ops scripts for the Rome Bridge contracts: paymaster (legacy), SPL_ERC20 wrappers (`WUSDC`, `WETH`, `WSOL`, plus per-asset `W{Symbol}` deploys), and `RomeBridgeWithdraw`.

Token nomenclature follows the canonical W-prefix standard.

**Read `contracts/bridge/README.md` first** — it covers the architecture, the four bridge flows, and the non-obvious problems that shaped the design (single-tx compute-budget limit, missing SPL Approve, stale canonical mints, etc.). This file is the operational companion.

## Deploy scripts

- `constants.ts` — canonical Solana program IDs (mainnet + devnet), SPL mint pubkeys, CCTP domains, Wormhole chain IDs. `SPL_MINTS_DEVNET.WETH_WORMHOLE` must match the canonical wrapped-ETH mint for the Ethereum chain you are bridging from.
- `deploy.ts` — deploys `RomeBridgeWithdraw` 13.0.0 against the existing USDC wrapper (`USDC_MINT` required). It deploys with **no CCTP domain and empty Wormhole lists**: the owner switches those on afterwards. `BRIDGE_OWNER` and `BRIDGE_GUARDIAN` set the owner and the stop-only guardian (both required on Rubicon, where the owner is the cold Ledger and `WORMHOLE_ADMIN` is ignored; the owner must not be the deploy key). Reads back version, owner, guardian and the empty domain list before it writes `deployments/{network}.json`. **Rubicon first use needs two Ledger transactions after the deploy**: `ensureBridgeAta(USDC mint)` and `enableCctpDomain(0, 1)` (the script prints the second).
- `enable-cctp-domains.ts` — `--network <name> --domains 0,1,3,6:evm,8:raw32` (or `--registry <bridge.json>`: every `sourceEvms[]` entry with a `cctpDomain` that is `live` or `preparing`): reads the live `cctpDomains()`, diffs it against the wanted list in both directions, and **prints** the target address and calldata of each `enableCctpDomain` / `disableCctpDomain` call, with a dry run from the owner and the Circle account the contract will derive. It sends only with `--send`, only on a network it knows, only when the RPC does not report Rubicon's chain id (7531), only when `<NETWORK>_PRIVATE_KEY` is the contract's owner; Rubicon is print-only under any name. `--check` exits 1 when the chain differs from the list, or when Circle's live account of an enabled domain no longer passes the contract's checks (`--solana-rpc` or `SOLANA_RPC_URL`). Pure helpers and tests in `lib/cctp-domain-plan.ts`.
- `redeploy-withdraw-devnet-wh.ts` — redeploy only the withdraw contract against devnet Wormhole programs; reuses paymaster + wrappers.
- `redeploy-withdraw-canonical-weth.ts` — redeploy withdraw + new WETH wrapper bound to the canonical wrapped-ETH mint (used when refreshing on a chain where the WETH wrapper still points at a stale mint).
- `redeploy-withdraw-only.ts` — redeploy withdraw with mainnet Wormhole programs (production path).
- `deploy-weth-v9.ts`, `deploy-wsol-v9.ts` — minimal SPL_ERC20 wrapper redeploys carrying the v9 outbound surface (`bridgeOutToSolana` + `ensureRecipientAta` + `balanceOf` reads from AUTHORITY_PDA). Use these to refresh wrappers on a chain after the contract upgrade. They do not touch the factory or paymaster.
- `ensure-bridge-atas.ts` — v10 rollout step 3, OWNER-only: `ensureBridgeAta(mint)` once per bridged mint before its first burn (`transfer_spl_from_ata` has no create leg; the ATA is paid from operator rent, hence owner-gated). Reads the bridge from `deployments/{network}.json`, the mints from its `SPL_ERC20_*` wrappers (or `BRIDGE_ATA_MINTS`), the bridge PDA from the HelperProgram `pda()` view; checks each ATA on Solana first (skip if present) and reads it back after the call. `DRY_RUN=1` reports without writing. Run from `contract-deploys/bridge-ensure-ata.yml` (owner key lives in the GitHub Environment). Pure helpers + tests in `lib/ensure-bridge-atas.ts`.
- `derive/cctp-accounts.ts` — derives the CCTP PDAs via `PublicKey.findProgramAddressSync`, and `deriveRemoteTokenMessenger(domain)` (Circle's per-domain account, which the v13 contract derives on chain too).
- `derive/wormhole-accounts.ts` — derives the Wormhole PDAs. `deriveWormholeGlobalAccounts` is the mint-independent set the v13 constructor takes; `deriveWormholeAccounts` adds the per-mint custody and `wrappedMeta`.
- `lib/canonical-mint.ts` — derives the canonical wrapped-ETH mint from `(tokenChain, tokenAddress, tokenBridgeProgramId)` per Wormhole's seed scheme. Always use this to resolve the wETH mint rather than hard-coding.
- `lib/verify-mint-on-chain.ts` — verifies the derived mint exists on Solana.

## Flow / test scripts

- `submit-burn.ts` — outbound CCTP: single `burnUSDC(amount, ethRecipient)` tx on Rome.
- `outbound-wh-e2e.ts` — outbound Wormhole E2E: sends `approve_spl(bridge, amount, mint)` direct to `0xff..09` (the bridge's pull-delegate precondition), then `burnToWormhole(wrapper, amount, recipient, targetChain)`. (`burnETH` and `submit-burnETH.ts` are gone in 13.0.0.) Needs the owner to have allowed the mint and the chain with `set-wormhole-allowlist.ts`.
- `smoke-emulate-all.ts` — quick `rome_emulateTx` health check for `burnUSDC` and the `approve_spl` precondition. `burnToWormhole` is skipped because it needs that delegate already live on-chain to emulate cleanly.
- `inbound/` — scripts for Sepolia → Rome inbound flows (CCTP deposit, Wormhole transfer, manual VAA complete).
- `try-burn.ts`, `smoke-test-canonical.ts` — legacy integration helpers used during initial bring-up; kept for reference.

## Usage

### Local

Requires `the local dev stack/deploy/start-local.sh` running. CCTP + Wormhole programs must be present in the local Solana cluster (they're seeded by the local dev stack; if you see deploy errors referencing unknown programs, verify your local stack seeded them).

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
2. The backend's `TokenCreated` event indexer picks up the new wrapper and surfaces it in `the app`'s portfolio + bridge picker. The bridge picker auto-includes it because `useRomeHoldings` filters on `kind === "wrap"`.

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
