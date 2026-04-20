# Rome Bridge Phase 1 — Deploy Scripts

Deploy script for the Rome Bridge contracts: paymaster, SPL_ERC20 wrappers (rUSDC, rETH), and withdraw. See `rome-product/specs/rome-bridge-phase1.md` for the design.

## Files

- `constants.ts` — canonical Solana program IDs, SPL mint pubkeys, CCTP domains, Wormhole chain IDs.
- `deploy.ts` — one-shot deploy for paymaster + SPL_ERC20 (rUSDC, rETH) + withdraw. Allowlists the `burnUSDC` and `burnETH` selectors on the paymaster. Writes deployment addresses to `deployments/{network}.json`.
- `derive/cctp-accounts.ts` — derives the 6 CCTP PDAs via `PublicKey.findProgramAddressSync`.
- `derive/wormhole-accounts.ts` — derives the 8 Wormhole PDAs.

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
