# Wormhole USDC: Sepolia → Rome (inbound)

Bridge **Circle Sepolia USDC** via Wormhole into **wrapped USDC** on Solana (shared with Rome), credited to your **Rome EVM user PDA’s ATA**.

## Prerequisites

- **Same EVM key** on Sepolia and Rome (`SEPOLIA_PRIVATE_KEY` + `MONTI_SPL_PRIVATE_KEY`).
- **Sepolia:** ETH (gas) + USDC to send.
- **Rome:** native balance on that address (gas for claim, ATA, CPI reads).
- RPC: `monti_spl_env` uses `https://montispl-i.devnet.romeprotocol.xyz/` (see `hardhat.config.ts`).

## One-time env (each shell)

```bash
cd /path/to/rome-solidity

export SEPOLIA_PRIVATE_KEY='0x…'
export MONTI_SPL_PRIVATE_KEY='0x…'    # same key as Sepolia
export SEPOLIA_RPC_URL='https://ethereum-sepolia-rpc.publicnode.com'

export USDC_ADDRESS='0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'
export AMOUNT='1'                       # whole USDC units (string)
export USDC_DECIMALS='6'

# Solana JSON-RPC for post_vaa + claim (default: public devnet)
# export SOLANA_RPC_URL='https://api.devnet.solana.com'
```

---

## Option A — One script (recommended)

Lock Sepolia → poll VAA → claim Rome → PDA ATA + CPI balance:

```bash
PHASE=full npx hardhat run scripts/wormhole_usdc/inbound.ts --network monti_spl_env
```

VAA polling can take **many minutes**. If the send succeeded but claim failed, resume with the sequence from the send output:

```bash
export SKIP_SEND=1
export SEQ='<sequence_from_send>'

PHASE=full npx hardhat run scripts/wormhole_usdc/inbound.ts --network monti_spl_env
```

You can use **`VAA_B64=<base64>`** instead of **`SEQ`** when claiming (see `wormhole_sepolia_to_rome.ts`).

---

## Option B — Split send and claim

**1. Lock USDC on Sepolia** (prints **Sequence**):

```bash
PHASE=send npx hardhat run scripts/wormhole_sepolia_to_rome.ts --network sepolia_env
```

**2. After the VAA is signed** (often ~15+ min), **claim on Rome**:

```bash
export SEQ='<sequence_from_step_1>'

PHASE=claim npx hardhat run scripts/wormhole_sepolia_to_rome.ts --network monti_spl_env
```

**3. PDA ATA + balance** (default `PHASE=all`):

```bash
npx hardhat run scripts/wormhole_usdc/inbound.ts --network monti_spl_env
```

---

## `inbound.ts` phases

| `PHASE` | Action |
|--------|--------|
| `full` | Full pipeline (see Option A) |
| `all` (default) | Create PDA ATA if missing, then CPI balance |
| `setup` | Create PDA ATA only |
| `balance` | Wrapped USDC on PDA ATA (reads **Solana devnet** via `SOLANA_RPC_URL`, not Rome CPI) |

**Balance-only** (after funds are on-chain):

```bash
PHASE=balance npx hardhat run scripts/wormhole_usdc/inbound.ts --network monti_spl_env
```

**`OWNER=payer`** — use the Solana-key ATA instead of the PDA ATA. For Wormhole inbound, the default **PDA** ATA is usually what you want.

**`SOLANA_RPC_URL`** — Solana endpoint for `wormhole_sepolia_to_rome.ts` post-VAA + claim txs (defaults to **`https://api.devnet.solana.com`**). Claim no longer calls `RomeWormholeBridge.bridgeUserPda()` on Rome EVM (avoids Rome-internal Solana 502s during eth_call).

---

## See also

- `scripts/wormhole_sepolia_to_rome.ts` — env vars and `PHASE=send` / `claim` details.
- **Outbound** (Rome → Sepolia): `scripts/wormhole_rome_to_sepolia.ts`.
- **`SPL_ERC20` `balanceOf`** is separate from the CPI read in `inbound.ts`; CPI matches on-chain SPL for the PDA ATA.
