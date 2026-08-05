# Leaf 2 — hook-aware wrapper cold-recipient parity, Hadrian

Date: 2026-08-05
Status: PASS

## Purpose

Verify that the optimized direct-CPI Token-2022 hook wrapper preserves the
ordinary wrapper experience for a first transfer: the caller supplies no
recipient ATA and does no UI/client preflight. The wrapper must discover that
the ATA is absent, create it idempotently, and then execute the armed-hook
transfer.

## Method

The deployed pre-optimization wrapper and a freshly deployed optimized wrapper
each transferred 1,000 units of the same armed Token-2022 mint to a distinct,
new EVM address. Distinct recipients are necessary for both calls to exercise
the cold branch. Before each transaction, the recipient's derived Token-2022
ATA was confirmed absent through Solana RPC.

## Result

| Track | Recipient ATA before | Recipient ATA after | Balance after | Settlement CU |
|---|---|---|---:|---:|
| Baseline | absent | created | 1,000 | 717,501 |
| Optimized | absent | created | 1,000 | 609,108 |

Both transfers used the same armed mint, hook program, validation PDA, sender,
amount, and two-account hook trailer. The contract—not the UI—created the
recipient ATA. The optimized wrapper therefore preserves the existing
check-if-exists / create-if-missing behavior while reducing this single cold
sample by 108,393 settlement CU. That cost difference is directional; the
behavioral conclusion is the primary result of this test.

## Outer receipts

- Baseline: https://via-hadrian.testnet.romeprotocol.xyz/tx/0x018a1fcbbcb9cfc811ab5488fb7f2a9f24870cc807d3e0b5dd463d12fd65c82f
- Optimized: https://via-hadrian.testnet.romeprotocol.xyz/tx/0x22712d9a387c9a98f1e2d7886ab22f0e9a8826301d416464616d1ea02e07472d

Machine-readable evidence:
`leaf2-token2022-hooked-wrapper-cold-hadrian-1785950702635.json`.
