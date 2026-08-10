# B0a Token ACL fixture — Devnet

**Status:** native policy admission is proven; the Rome EVM-wrapper transfer
and revoke portions remain in progress.

This is a controlled Rome fixture, not a named-issuer integration and not a
production asset. It contains no KYC data or investor identity fields.

## Fixed account graph

| Role | Value |
|---|---|
| Network | internal Solana Devnet endpoint (not public RPC) |
| Rome EVM program | `RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf` |
| Token-2022 mint | `8qogpvhrFXJHtHD6bY8r2jjXAL2sBF7Uza27sN8uHJKL` |
| Token program | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| Token ACL program | `TACLkU6CiCdkQN2MjoyDkVg2yAH9zkxiHDsiztQ52TP` |
| Token ACL Gate program | `GATEzzqxhJnsWF6vHRsgtixxSB8PaQdcqGEVTEHWiULz` |
| Allow-list config | `DdNrTAyTbRH1dRVUYvi6QKhV5atfDvCxNqevsiqbs9Tr` |
| Approved EVM address | `0x000000000000000000000000000000000000b0a1` |
| Approved Rome PDA | `7tcTLwDHQnGMWDKy5MqrF5SEVY8yiQeMAvSrv4eNbfZy` |
| Approved canonical ATA | `DXKsqxD2nLo63W3xuiYoRpm1BiTNjL3bvZyAtzH1SRC3` |
| Denied EVM address | `0x000000000000000000000000000000000000b0a2` |
| Denied Rome PDA | `FZM23K3EXDCa4UGi3aNi1TfimE9ubFDwDCdGvDDwxqW5` |

The mint is Token-2022 with `DefaultAccountState = frozen`, a freeze authority,
initialized metadata, no armed transfer hook, and zero transfer fee. Token ACL
holds delegated freeze authority; permissionless thaw is enabled, and the Gate
program resolves the allow list for each thaw attempt.

## Native lifecycle evidence

| Step | Result | Receipt / evidence |
|---|---|---|
| Create default-frozen Token-2022 mint | Passed | [transaction](https://explorer.solana.com/tx/3WT4X7H62wd3aeUdey996s5SWeYy6UZFFtbJHbAnttPB98svfeysMUGdWXXGEx6nn9PSg2UiCDAe9YNMUpwQYZhv?cluster=devnet) |
| Initialize required Token-2022 metadata | Passed | [transaction](https://explorer.solana.com/tx/itNHZ22pcbzZYsmb6BgHKaZVNsg9Qd98za4mCnV7ZJ73ptpKFeGUYDAsPQugegxXyrmQpuFXg3Jz2ZAVTv5Gbzb?cluster=devnet) |
| Create Token ACL config and delegate freeze authority | Passed | [transaction](https://explorer.solana.com/tx/129JhtcXQRoND6xiABXFTGWY8y2umcpG4JYErHWt7pBsdYPu9SgbShhYvdTW1Lmz4rm1UZ5GE7t4GYGa69ccT87M?cluster=devnet) |
| Add approved Rome PDA to allow list | Passed | [transaction](https://explorer.solana.com/tx/3iGjNeSKMrQ2Q7oFqhsNucnM2JySb276uGGZWYC76VnLLLDVtQsqQzVzXwYfqy5oLhu3zYfSKHAjUEHeK4vKNq9i?cluster=devnet) |
| Create and permissionlessly thaw approved ATA | Passed | [transaction](https://explorer.solana.com/tx/5eRJ6ZhEvoj1SjQUpLuiMgZwNU6gR2YzFDR1oCKHAvkwbwaFPd8bfwhr3gfWn8rEjxWFKLTkzxmYyEt8hvwwzn79?cluster=devnet) |
| Mint fixture supply to approved ATA | Passed | [transaction](https://explorer.solana.com/tx/2gWURtgTgFrTWivVxsw1UkMtRX7FANj2QWM51JeT5CRGsw31B1BzGUoqhaMThCQbntQff1PTFdjtubbRGT57NUPV?cluster=devnet) |
| Unlisted Rome PDA attempts create-and-thaw | Denied atomically | Token ACL returned custom error `0x2`; the expected ATA was not created |

The approved ATA reports `state = initialized`, owner equal to the Rome-derived
PDA, Token-2022 program ownership, and a one-million-unit fixture balance.

## Integration boundary

The fixture proves that the issuer-side policy can admit an exact Rome-derived
owner and canonical Token-2022 ATA, while refusing a different deterministic
Rome PDA. It does not yet prove that the approved EVM wallet can invoke Rome's
strict RWA wrapper, nor the removal/freeze/revocation part of the lifecycle.
Those are the next B1 receipts.

## Tooling note

The upstream `token-acl-gate-cli` source omitted the mandatory `payer` account
from its `create-list` and `add-wallet` instruction builders. A local-only
two-line patch was used to run this fixture; it is not part of Rome source and
should be reported upstream before selecting the CLI as an operational tool.
