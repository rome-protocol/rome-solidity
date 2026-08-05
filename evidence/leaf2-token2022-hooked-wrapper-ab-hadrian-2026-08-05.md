# Leaf 2 — hook-aware wrapper CU A/B, Hadrian

Date: 2026-08-05
Status: PASS
Scope: warmed-recipient Token-2022 transfer through a real armed Transfer Hook.

## Question

Does the hook-aware wrapper optimization reduce the actual Rome/Solana cost of
the production direct-CPI transfer path?

## Controls

The benchmark alternated the immutable production wrapper from the prior
Hadrian proof with a fresh deployment of the optimized implementation. Each
sample used the same:

- Token-2022 mint: `75wP528i7uzEH9NGJa1cpFigDrLE4bnb1kS1MUauRkSz`
- armed hook program and canonical validation PDA;
- EVM-derived sender, transfer amount (1,000 base units), and already-created
  recipient ATA;
- two-account dynamic hook tail: hook program + validation PDA.

This intentionally measures the warm transfer path only. It excludes wrapper
deployment and ATA creation, which are separate operations.

## Result

| Metric | Baseline wrapper | Optimized wrapper | Delta |
|---|---:|---:|---:|
| Samples | 3 | 3 | — |
| Mean Solana settlement CU | 536,698 | 445,680 | **-91,017 (-17.0%)** |
| Rome heap | 50,648 B | 47,088 B | **-3,560 B** |
| Requested CU | 582,126–586,676 | 490,626–496,626 | lower by ~91–92k |
| EVM receipt gas | 10,001 | 10,001 | 0 |

Both tracks settled successfully and the native fee was 5,001 lamports in all
six samples. The conclusion is based on Solana `computeUnitsConsumed` after
mapping each outer EVM transaction with `rome_solanaTxForEvmTx`, not on EVM
receipt gas.

## Receipts

Baseline:

- https://via-hadrian.testnet.romeprotocol.xyz/tx/0xbdad17102af1ac88aa3347926f10d07d081042c04818778605c648bbf1dabd22
- https://via-hadrian.testnet.romeprotocol.xyz/tx/0x1fbc9e8e20cbe0a1b00f4e7e2b8d6156d693c622cfdca6486d3d4f6dd1537945
- https://via-hadrian.testnet.romeprotocol.xyz/tx/0x6c1f44e2965bcfc680066e0412643ec7003588c083250e2f934b9ddb4e456fa2

Optimized:

- https://via-hadrian.testnet.romeprotocol.xyz/tx/0x2a14e2260e9e9d97e7bfd56d2dc92e12db1662cc7e56f4abbedaf54ca5cc242d
- https://via-hadrian.testnet.romeprotocol.xyz/tx/0xd869a43419d169c8bf1a224ac8de2210e4425dc22833a15b5f9ae3699b7c3782
- https://via-hadrian.testnet.romeprotocol.xyz/tx/0xa1c5095ffa826f2122abd9647f812d89931fa707721141d9968118cd709bfd62

The machine-readable samples are in
`leaf2-token2022-hooked-wrapper-ab-hadrian-1785950679436.json`.

## Interpretation

The reduction is from Solidity/wrapper work that is repeated on every direct
CPI transfer: no duplicate mint-info precompile read, calldata retained until
the single required CPI meta allocation, and a compact TransferChecked data
encoder. It does **not** remove the live mint/hook-plan validation, dynamic
account tail, or fresh-account safety behavior.

This is strong evidence for the warmed direct-CPI wrapper path. It is not a
claim about every issuer hook: a non-empty ExtraAccountMetaList or additional
hook-side program logic must be measured with that issuer's actual account plan.
