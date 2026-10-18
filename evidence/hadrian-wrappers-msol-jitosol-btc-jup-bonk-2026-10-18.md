# Hadrian wrappers for mSOL, JitoSOL, BTC, JUP and BONK (2026-10-18)

Factory: ERC20SPLFactory 9.0.0 `0x37c13e4ff21fb914eb24014dcbd0f8dbeaa31078`, cached track, created with
`WRAPPER_SET=hadrian-restore npx hardhat run scripts/bridge/bootstrap-bridged-wrappers.ts --network hadrian`
(signer F6 `0x1f4946Be340F06c46A50E65084790968aBcc48F6`).

| Symbol | Wrapper | Mint | Dec | createTx |
|---|---|---|---|---|
| msol | `0x34b1eD3A33C522F01fACED591DEa9E0468E9614A` | mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So | 9 | `0x7fcf38c4...9b98` |
| wJitoSOL | `0x8874ce9D11dd54Ee0Bc8185A05F216f2E7bA1a8D` | 8uz9RSxeKQxS1q3Cvs8xzNDTapUdJWRZhcHG2GegEtMS | 8 | `0xa669a58e...27a5` |
| wBTC | `0x94834153eA70219D44edFE295697fF0c204Ec68c` | 2gsErzRCTA7T6hGnYo44EnpP7hP79CHQerDhtmggkZZF | 9 | `0xb5fbd5dc...8d27` |
| wJUP | `0x0B04Ce26bce2128309956bf2aeD03ac7e8d3E3De` | Aa58JCN8MCDPSAPe6qZiL1ZWtqxVDRdSjH6EGjku5vFe | 9 | `0x5e31c0d0...e0b4` |
| wBONK | `0xE72168524e9DE5d654BFe8473CA11a8108Cd642b` | HWeLrJqWKK3yDfqkGucGq9RpgfU75W1UE5iVL23BSw4Y | 9 | `0x08e5692f...5ad9` |

Full hashes are in `deployments/hadrian.json` and the registry patch next to this file.

Reads after the deploy: every wrapper has code (5575 bytes), `mint_id()`, `name()`, `symbol()` and `decimals()` equal the
retired wrapper's, and `factory.token_by_mint(mint)` returns the new wrapper with kind 1 (cached).

One-unit transfer from F6 to `0x...dEaD` after F6's `HelperProgram.approve_spl(wrapper, 2^64-1, mint)` grant
(gas limit = eth_estimateGas x 1.3, legacy tx at 2x gas price). Balance read before and after:

| Symbol | approve_spl tx | transfer tx | F6 before -> after | recipient before -> after |
|---|---|---|---|---|
| wBTC | `0x005a79c51e404a223ad02483dabb0c70cdc6db767a9ce3088dbcc8502e74ac6f` | `0xddeed9195f6821b51d27cf77045565696169f2072dc40e70887ad7b50f84d3bd` | 717834583800000 -> 717834583799999 | 0 -> 1 |
| wJUP | `0xa309acc92732ceb305b1633275b5bf4c7132554b7deba839115fced37ae551b8` | `0x142e33ee5a6f2ec0098dc68cb8c13b22263ac7f80d84de4127f9d1e234c0154c` | 719633697300000 -> 719633697299999 | 0 -> 1 |
| wBONK | `0xde4439e9498acb43d40a500ea49c7ec9bbe5eee777425b6f7ebd4dc14b48b7af` | `0x6bbbb3e0fffc08b7efd22a734689ed031d586882ba345ddb1c1b33d831029c99` | 719632697200000 -> 719632697199999 | 0 -> 1 |

mSOL and JitoSOL: F6 holds none of these two mints (balanceOf 0), and the devnet holders of them are other Solana wallets
whose keys we do not hold, so the transfer was not run. Reads work: wrapper `totalSupply()` equals the mint supply
(mSOL 438256937945788, JitoSOL 49600000), the same as the retired mSOL wrapper's.

Mint choice: mSOL and JitoSOL use the mints Cardo's Meteora pools sit on (the real devnet Marinade mint and the
Wormhole JitoSOL, 8 decimals). The old Aerarium comet used different test mints for its wmSOL (`jc65vCfD...`) and wJitoSOL
(`8Eou1ZHT...`); F6 holds those. BTC, JUP and BONK are the same mints Aerarium and the retired wrappers used.
