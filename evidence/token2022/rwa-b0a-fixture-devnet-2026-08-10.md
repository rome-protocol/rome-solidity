# B0a Token ACL fixture — Devnet

**Status:** B0a/B1 complete — native policy admission, EVM-wrapper transfer,
and native revocation enforcement are proven against the controlled fixture.

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
| Strict-wrapper factory (fixture only) | `0xf2b9e9f323f20754ddc58a40b80ae32377d4ded1` |
| Strict ERC-20 facade | `0x2e23C50EF242c8dfA0D704e4AE5295061C242e1D` |
| Approved EVM address | `0x000000000000000000000000000000000000b0a1` |
| Approved Rome PDA | `7tcTLwDHQnGMWDKy5MqrF5SEVY8yiQeMAvSrv4eNbfZy` |
| Approved canonical ATA | `DXKsqxD2nLo63W3xuiYoRpm1BiTNjL3bvZyAtzH1SRC3` |
| Denied EVM address | `0x000000000000000000000000000000000000b0a2` |
| Denied Rome PDA | `FZM23K3EXDCa4UGi3aNi1TfimE9ubFDwDCdGvDDwxqW5` |
| EVM holder (controlled fixture) | `0x8A952cdCB77FD061ECb619D613eB54F1F2411E8b` |
| Holder Rome PDA / Token-2022 ATA | `FaRgFE7DGoX8ntU3f1GFBeAXCCtR6Fo83BJuVUonCKVw` / `AEAkzYEHY13vSqnph9WP4HcyLy8qNPREyShQZBzEzKQF` |
| EVM recipient / Rome PDA / Token-2022 ATA | `0x1f4946Be340F06c46A50E65084790968aBcc48F6` / `3E7gp1p8CfZ8kXMUagqKQWYZijQm7hxkrE67eQZPLdfv` / `3pKXuseMuLApFCcg799ziWsoMvM9MVFwfVfLLgV4FKtz` |

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
| Admit controlled EVM holder PDA and thaw its ATA | Passed | [allow](https://explorer.solana.com/tx/598nUd9hif95969oqcX5xcqNKYYkNecK9ZMjeQHjurGYYWZJHT2opEPBZsj5TyGr8rk5scaqh3HzE8DP5f5T5rbn?cluster=devnet), [thaw](https://explorer.solana.com/tx/5i63JNHKa71hr9uFGBf7w5wVBbi5pScXuCc6HuzrTim3TwuBJDpxuh9pwhdaWgwJ1R5ZTYbKhaTQZ98SD2eHsKB9?cluster=devnet) |
| Register fixture mint through strict RWA factory | Passed; `wrapper_kind_by_mint = 3` | Hadrian tx `0x539e3a293d75a02d65244a5d866850b0bbc121608be8a81138b42445bf91620e` |
| EVM holder transfers 1.000000 token through strict facade | Passed; direct native ATA reads verified exact debit/credit | Hadrian tx `0xe5b0210651cf45d34fd212ec01e7d38a4f6b9cfeeb446133dc97d7d4aeee59c5` |
| Remove holder PDA from allow list and freeze its ATA | Passed | [remove](https://explorer.solana.com/tx/4YeREC6F2gKLT1zoy8sE2Y7gcH3jDT4vx8q7hk71EEKB1WbSG4VezeTVGnSsrzdotxAsvvEvUxV6WeprpMVAbQa?cluster=devnet), [freeze](https://explorer.solana.com/tx/4sNjCVSWG6B6xTMQBBx8GmKYFSiHQreyZhDC5AWCNmZu1tC5Jo8g4KdsQVrKAViAsc3XgQ6zPqd1VrYMCmxsgymW?cluster=devnet) |
| Frozen holder attempts same EVM transfer | Denied; wrapper simulation rejected and direct native ATA reads proved both balances unchanged | No transaction was broadcast (preflight rejection) |

The final holder ATA reports `state = frozen`, owner equal to the Rome-derived
PDA, and Token-2022 program ownership. The fixture is intentionally left frozen
after the revoke proof.

## Integration boundary

The fixture proves that issuer-side policy can admit an exact Rome-derived owner
and canonical Token-2022 ATA while refusing a different deterministic Rome PDA.
It also proves that an approved EVM wallet can move the real Token-2022 balance
through the strict wrapper, and that issuer revocation on Solana blocks that
same EVM route. There is no bridge, escrow, or duplicate EVM representation.

The factory and facade above are controlled-test identities, not canonical
registry entries or a production deployment. The reproducible harness is
`scripts/token2022/b0a-rwa-standard-hadrian.ts`; its paths and credentials are
environment inputs and are never committed.

## Tooling note

The upstream `token-acl-gate-cli` source omitted the mandatory `payer` account
from its `create-list` and `add-wallet` instruction builders. A local-only
two-line patch was used to run this fixture; it is not part of Rome source and
should be reported upstream before selecting the CLI as an operational tool.
