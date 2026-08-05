# Leaf 2 — production hook-aware wrapper Hadrian evidence

Date: 5 August 2026  
Status: PASS

## What this proves

The production implementation—not the earlier generic spike adapter—completed
the full path on Hadrian:

```text
ERC20SPLFactory
  -> SPL_ERC20_Token2022Hooked
  -> Rome generic CPI precompile (delegatecall)
  -> Token-2022 TransferChecked
  -> armed Transfer Hook
  -> destination Token-2022 ATA
```

The factory read the mint's armed hook through `mint_info`, deployed the third
wrapper type, and recorded `wrapperKind = 2` (`Token2022HookedCpi`). The wrapper
pinned the expected hook program and derived the canonical
`extra-account-metas` validation PDA.

## Public identifiers

- Mint: `75wP528i7uzEH9NGJa1cpFigDrLE4bnb1kS1MUauRkSz`
- Hook program: `6e52qcdWaHV1DHnafeCWf2FuAH2fqj13nAD1KVoZWTm3`
- Validation PDA: `3XK9JaBnrEHsXrLK455Vz6hXxtSP2qxMZw8uEJk1QzH6`
- Factory: `0xd261b634583d2aaaa07b6a9d4c055db8ce1cfd1c`
- Factory-created wrapper: `0xD80B71b26F1FB45917142077a69E597186e1BEA8`

## Transactions

- [Factory deployment](https://via-hadrian.testnet.romeprotocol.xyz/tx/0xec82f3ce35f8458346b677868e1f1b794550b94d639139dbed21097e8b9f2aa4)
- [Armed mint registration and wrapper creation](https://via-hadrian.testnet.romeprotocol.xyz/tx/0x6a604c47c48ac23e4b959eb7591bdf9b6c00acf6846465428faa9b1a447ba2be)
- [Hook-aware transfer](https://via-hadrian.testnet.romeprotocol.xyz/tx/0x7a70d3044f7df082ea91987883010e9465a02c5b2882feba2fa8c6760ad246dd)

## Safety negative

Calling the ordinary ERC-20 `transfer(address,uint256)` surface reverted during
simulation with `HookAccountPlanRequired()`. No transaction was broadcast and
neither source nor destination balance moved. This prevents an integration from
silently omitting the hook accounts.

The hook-aware call then supplied the fixture's complete account tail:

```text
[hook program, validation PDA]
```

This fixture's `ExtraAccountMetaList` is empty, so those two invariant trailer
accounts are the complete plan. Production hooks with resolved policy accounts
use the official order:

```text
[resolved policy accounts..., hook program, validation PDA]
```

## Balance proof

| Account | Before | After | Delta |
|---|---:|---:|---:|
| Source ATA `2gez…iEPd` | 1,000,000 | 999,000 | -1,000 |
| Recipient ATA `2Qq1…1MK3` | 0 | 1,000 | +1,000 |

Raw machine-readable receipt:
`leaf2-token2022-production-wrapper-hadrian-1785943190067.json`.

## Local regression evidence

- `npx hardhat compile --force`: PASS, 94 Solidity files.
- Token-2022 suite: 54 passing.
- Full local Node suite: 344 passing.
- Runtime bytecode: factory 16,986 bytes; hooked wrapper 8,854 bytes;
  factory-owned hooked deployer 11,674 bytes. All remain below EIP-170.

## Remaining boundary

This on-chain receipt proves the actual production wrapper against a genuinely
armed hook with an empty resolved policy list. A named issuer integration must
still resolve and test that issuer's non-empty `ExtraAccountMetaList` and target
market action. That is per-application admission work, not a Rome EVM program
change.
