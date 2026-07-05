# RomeBridgeWithdraw v8 — multi-asset / multi-chain Wormhole egress

**Audience:** engineer + operator deploying the next `RomeBridgeWithdraw`.
**Why v8:** the deployed v7 (`0xeeb85da5…` on Hadrian) has a **constructor-frozen** Wormhole allowlist — only `wETH` + Sepolia (10002) are permitted, and there is **no setter**, so every new asset or chain needed a full redeploy. v8 adds an owner + setters so assets/chains are enabled on the **live** contract with a tx.

## What changed in the contract
- `WormholeGenericConfig.admin` (new ctor field) → seeds `owner`. Reverts `ZeroOwner` if 0x0.
- `owner` (public, transferable) + `onlyOwner` (ERC2771 `_msgSender()`-aware).
- `setWormholeAssetAllowed(address wrapper, bool)` — enable/disable a burn asset. `onlyOwner`.
- `setWormholeTargetChainAllowed(uint16 whChainId, bool)` — enable/disable a destination. `onlyOwner`.
- `transferOwnership(address)` — cold-ledger / multisig handover; zero-guarded. Matches this repo's mainnet admin-handover flow (`scripts/transfer-admin-to-ledger.ts`).
- Events: `OwnershipTransferred`, `WormholeAssetAllowedSet`, `WormholeTargetChainAllowedSet`.
- The ctor allowlist is now a **seed**, not a cage. Every value path (burnUSDC/burnETH/burnToWormhole/bridgeOutToSolana) stays permissionless — the owner only gates the two allowlist setters + ownership.
- Guard suite: `tests/bridge/rome_bridge_withdraw_wormhole_generic.test.ts` — 15 green (8 original + 7 new: owner recorded, asset/chain enable+revoke, non-owner rejection, transferOwnership + old-owner-powerless + zero-guard).

## Deploy (operator-gated)
1. `deploy.ts` already wires `admin` — defaults to the deployer; override with `WORMHOLE_ADMIN=0x…` for a cold-ledger / Squads owner. Seed the ctor allowlist with what's ready (at minimum wETH + Sepolia, matching v7).
   `WORMHOLE_ADMIN=0x<cold> USDC_MINT=… WETH_MINT=… npx hardhat run scripts/bridge/deploy.ts --network hadrian`
2. Verify on-chain: `owner()` == admin; `wormholeTargetChainAllowed(10002)` == true.
3. Register the new address in the registry (`RomeBridgeWithdraw` → v8, status live) via `/publish-registry-pr add-contract`. The bridge-api + rome-ui resolve `liveContractAddress("RomeBridgeWithdraw")`, so they pick it up automatically once live.
4. Enable further assets/chains with setter txs signed by the owner — **no redeploy**.

## Per-asset prerequisites (BOTH required before an asset can Wormhole-out)
1. **An ERC20-SPL wrapper on Rome.** `burnToWormhole(assetWrapper,…)` takes a *wrapper address*, not a raw mint (unlike the Solana egress). **No wmSOL wrapper exists today** — deploy one via `ERC20SPLFactory.add_spl_token_no_metadata(mint, name, symbol)`, then `setWormholeAssetAllowed(wrapper, true)`.
2. **Wormhole attestation on the destination.** The token must be attested with the Wormhole token bridge on the target network so the wrapped asset can mint there. wETH is attested; verify per (asset, chain) before enabling — an un-attested asset burns on Rome but has nothing to redeem into.

## Wormhole chain ids (destination allowlist values)
| Chain | Wormhole id | v7 status |
|---|---|---|
| Sepolia | 10002 | ✅ live |
| Ethereum | 2 | enable in v8 |
| Arbitrum One | 23 | enable in v8 |
| Arbitrum Sepolia | 10003 | enable in v8 |
| Avalanche / Fuji | 6 | enable in v8 |
| Base | 30 | enable in v8 |
| Base Sepolia | 10004 | enable in v8 |

## bridge-api side — READY
`src/route-builders/token-wormhole-outbound.ts` (`token-wormhole-from-rome`, asset `TOKEN`) emits `[approveWormholeBurn, burnToWormhole, wormhole-claim-on-destination]` on the live `RomeBridgeWithdraw`. Inputs: `splAsset.wrapper` (the ERC20-SPL wrapper) + `destinationChainId` (EVM id → mapped to the Wormhole id above). Redemption is Wormhole-native (user redeems the VAA — no bridge-api build, per the #25 decision). It works the moment v8 is live and the asset+chain are allowlisted.
