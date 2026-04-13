# Wormhole USDC: Sepolia → Rome (inbound)

Bridge **Circle Sepolia USDC** through Wormhole into **wrapped USDC** on Solana (shared with Rome), credited to your **Rome EVM user PDA’s ATA**.

## Single script: `inbound.ts`

| `PHASE` | What it does |
|--------|----------------|
| **`full`** | Lock on Sepolia → poll VAA → claim on Rome → create PDA ATA if needed → print balance (CPI) |
| `all` (default) | Create PDA ATA if missing, then print balance |
| `setup` | Only create PDA ATA |
| `balance` | Only CPI balance |

### End-to-end (`PHASE=full`)

```bash
export SEPOLIA_PRIVATE_KEY='0x…'
export MONTI_SPL_PRIVATE_KEY='0x…'
export SEPOLIA_RPC_URL='https://ethereum-sepolia-rpc.publicnode.com'
export USDC_ADDRESS='0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'
export AMOUNT='1'
export USDC_DECIMALS='6'
# Optional: RomeWormholeBridge on Rome (default in script — do not use Sepolia addresses here)
# export BRIDGE='0x79f34fa78651efa9d24ff8ac526cbd9753e8fc1f'

PHASE=full npx hardhat run scripts/wormhole_usdc/inbound.ts --network monti_spl_env
```

Skip the Sepolia lock (claim + ATA + balance only): **`SKIP_SEND=1`** with **`SEQ=<n>`** or **`VAA_B64=<base64>`**.

### ATA + balance only (after a claim, or local checks)

```bash
export MONTI_SPL_PRIVATE_KEY='0x…'
export USDC_ADDRESS='0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'   # optional

npx hardhat run scripts/wormhole_usdc/inbound.ts --network monti_spl_env
PHASE=setup npx hardhat run scripts/wormhole_usdc/inbound.ts --network monti_spl_env
PHASE=balance npx hardhat run scripts/wormhole_usdc/inbound.ts --network monti_spl_env
```

**`OWNER=payer`** targets the Solana-key ATA instead of the PDA ATA. For Wormhole inbound credits, use the default **PDA** ATA.

## Prerequisites

- Same **EVM private key** on Sepolia and Rome (`SEPOLIA_PRIVATE_KEY` / `MONTI_SPL_PRIVATE_KEY`).
- **Sepolia ETH** + **Sepolia USDC** for `PHASE=full` (send leg).
- **Rome native** on that address for gas (claim, ATA, CPI reads).
- RPC: **`https://montispl-i.devnet.romeprotocol.xyz/`** (`monti_spl` / `monti_spl_env` in `hardhat.config.ts`).

## Manual steps (optional)

Use **`scripts/wormhole_sepolia_to_rome.ts`** if you want separate **send** / **claim** runs: `PHASE=send` on `sepolia_env`, then `PHASE=claim` with `SEQ` on `monti_spl_env`. See that file’s header comment.

## Notes

- **`SPL_ERC20`** `balanceOf` is a separate path; the CPI read in `inbound.ts` matches on-chain SPL balance for the PDA ATA.
- **Outbound** (Rome → Sepolia): `scripts/wormhole_rome_to_sepolia.ts`.
