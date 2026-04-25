# Bridge hardening redeploy runbook (post-#55)

Use this **only** after rome-solidity #55 has merged to `main` and you have
the latest `contracts/bridge/` artifacts compiled on the deployer host.

The PR ships four hardening fixes:

| Fix | Contract | Severity | Constructor changed? | Forwarder change? |
|---|---|---|---|---|
| Pausable + `pause()`/`unpause()` | `RomeBridgePaymaster` | Operational | No | n/a |
| `sponsoredTxCap` mutable + `setSponsoredTxCap()` | `RomeBridgePaymaster` | Operational | No | n/a |
| `ReentrancyGuard` on `settleInbound` | `RomeBridgeInbound`   | **Security** | No | No |
| Slippage check after `unwrap_spl_to_gas` | `RomeBridgeInbound`   | **Security** | No | No |

## What this runbook covers

The conservative path: **redeploy `RomeBridgeInbound` only.** This delivers
both security-critical fixes with zero blast radius.

The paymaster (Pausable + mutable cap) stays put. Its constructor is
unchanged, but redeploying it would force a `RomeBridgeWithdraw` redeploy
too because Withdraw stores the forwarder as an immutable
`ERC2771Context` field. Pausable is operational — ship it later if/when
an incident makes it load-bearing.

## Steps

```bash
cd rome-solidity

# 1. Confirm you're on main + the artifacts match the merged PR.
git checkout main && git pull
npx hardhat compile

# 2. Make sure the deployer wallet has rUSDC for gas on Marcus.
#    (Funding floor in deployments/marcus.json's deployer notes.)

# 3. Run the redeploy script.
npx hardhat run scripts/bridge/redeploy-inbound.ts --network marcus

# Expected output:
#   - Deploys new RomeBridgeInbound at <NEW_ADDRESS>
#   - Archives old address under archive.RomeBridgeInboundPrevious
#   - Re-runs allowlist for (RomeBridgeInbound, settleInbound) on the paymaster
#   - Writes deployments/marcus.json
```

After the script writes `deployments/marcus.json`, **commit it** and open a
small PR (`chore(deploy): redeploy RomeBridgeInbound on Marcus post-#55`)
so the artifact's authoritative state is in `main`.

## Downstream updates (rome-ui)

The new address must propagate to three places:

1. **`rome-ui/deploy/chains.sample.yaml`** — line ~26, `marcus.contracts.romeBridgeInbound`.
   This is the committed canonical config.
2. **`rome-ui/backend/chains.yaml`** (operator-local, gitignored) — same
   field. Each operator updates their own copy.
3. **`rome-ui/src/server/bridge/flows/inboundCctp.ts`** — only if you
   redeployed the paymaster too (this redeploy doesn't, so leave it
   alone). The hardcoded `MARCUS_PAYMASTER_ADDRESS` env-fallback there is
   the paymaster, not the inbound.

After updating `chains.yaml`, restart the rome-ui backend so it re-reads.

## Smoke test

```bash
# 1. Confirm the new contract picked up the hardening:
npx hardhat console --network marcus
> const i = await viem.getContractAt("RomeBridgeInbound", "<NEW_ADDRESS>")
> // The reentrancy guard storage slot is _NOT_ENTERED (1) on a fresh deploy.
> // The slippage error UnexpectedUnwrapDelta is in the ABI:
> Object.keys(i.abi).filter(k => k.includes("Unexpected"))

# 2. End-to-end inbound bridge with gas-split:
#    Run an inbound CCTP bridge from Sepolia → Marcus through the rome-ui
#    portal. Watch the worker's [bridge-worker] settling-split phase
#    succeed against the new inbound address.

# 3. Negative test (best-effort):
#    Build a malicious wrapper deployment that re-enters settleInbound
#    inside its receive() and confirm the call reverts with
#    ReentrancyGuardReentrantCall — hard to exercise on real Marcus
#    without a custom mint, so the hardhat test in
#    tests/bridge/RomeBridgeInbound.test.ts is the authoritative proof.
```

## Rollback

If the new inbound misbehaves:

1. Revert `chains.sample.yaml` + `backend/chains.yaml` to the old address
   (still recorded in `deployments/marcus.json` under
   `archive.RomeBridgeInboundPrevious`).
2. Restart rome-ui backend.
3. The old (paymaster, settleInbound) allowlist entry was never removed
   — old bridges keep working immediately.
4. Open a hot-fix PR on rome-solidity, do not delete the new address from
   the deployment record (we want the trail).

## Why no Withdraw or paymaster touched

- **Withdraw** has no #55 changes. Bytecode unchanged.
- **Paymaster** has #55 changes (Pausable + mutable cap) but redeploying
  it cascades to both Withdraw and Inbound (immutable forwarder fields).
  The cost/benefit doesn't pencil out when the security-critical fixes
  are all in Inbound.

If a follow-up incident makes Pausable load-bearing, plan the full
triple-redeploy explicitly — that's a different runbook (TODO).
