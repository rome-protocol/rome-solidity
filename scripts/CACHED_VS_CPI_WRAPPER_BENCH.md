# SPL_ERC20_cached vs CPI-based SPL_ERC20 — wrapper-level Solana CU + heap

Apples-to-apples comparison on Hadrian. Same deployer-authored test mint, same operations.

- cached wrapper: `0x979cb140cd9593758496742f40ab37b41807284c`
- cpi    wrapper: `0x56b3e58D05e76Ab6F70F5c3C4B2f9EB966ceA7bD`
- shared mint:   `0xe129d398fb5bf9c7ffb56bfa0b855b101ea92c6d014be32283817301db843bed`

| Operation | Track | Status | EVM gas | Sol txs | Sol CU | Heap bytes |
|---|---|---|---:|---:|---:|---:|
| ensure_token_account(recipient) | cached | success | 10000 | 1 | 131030 | 19240 |
| ensure_token_account(recipient) | cpi | success | 10000 | 1 | 145262 | 23000 |
| mint_to(recipient, 1_000_000) | cached | success | 15000 | 2 | 256518 | 33304 |
| mint_to(recipient, 1_000_000) | cpi | success | 15000 | 2 | 264770 | 35936 |
| transfer(recip2, 100_000) | cached | success | 15000 | 2 | 279908 | 35008 |
| transfer(recip2, 100_000) | cpi | success | 15000 | 2 | 286801 | 36720 |
| approve(spender, 500_000) | cached | success | 15000 | 2 | 226018 | 30496 |
| approve(spender, 500_000) | cpi | success | 15000 | 2 | 216186 | 30208 |
| transferFrom(me, recip2, 50_000) | cached | success | 15000 | 2 | 272885 | 35040 |
| transferFrom(me, recip2, 50_000) | cpi | success | 15000 | 2 | 279562 | 36752 |

## Delta (cached − cpi, negative = cached saves)

| Operation | EVM gas Δ | Sol CU Δ | Heap Δ |
|---|---:|---:|---:|
| ensure_token_account(recipient) | 0 | -14232 | -3760 |
| mint_to(recipient, 1_000_000) | 0 | -8252 | -2632 |
| transfer(recip2, 100_000) | 0 | -6893 | -1712 |
| approve(spender, 500_000) | 0 | 9832 | 288 |
| transferFrom(me, recip2, 50_000) | 0 | -6677 | -1712 |
