# tROME wrappers on Hadrian and Martius (2026-11-03)

tROME is the devnet test copy of the ROME token: mint `92FWXdumEHGLGxsev83VQBWwy87sav1q5uxv9jm2XBGe` on Solana devnet
(classic SPL Token, 9 decimals, supply 1,000,000,000, mint authority revoked, Metaplex metadata "Rome (test)" / `tROME`).
Wrappers are created through ERC20SPLFactory on the cached track, with
`WRAPPER_SET=trome npx hardhat run scripts/bridge/bootstrap-bridged-wrappers.ts --network <hadrian|martius>`
(signer `0x1f4946Be340F06c46A50E65084790968aBcc48F6`). The script uses `add_spl_token_no_metadata` with name "Rome (test)" and
symbol `tROME` (the same values the mint's metadata carries); the factory did not read them from the mint.

| Chain | Factory | Wrapper | createTx |
|---|---|---|---|
| Hadrian 200010 | 9.0.0 `0x37c13e4ff21fb914eb24014dcbd0f8dbeaa31078` | `0x518cCB47CD145b9cf1f65Dd6adB6ba5F579274c5` | `0xe43255b35e6b7f8f91f7a7118d62af5cbddcea4803c08f2ef047b550c89e7ed1` |
| Martius 121214 | 2.0.0 `0x405ded76ebae104ebe8345a649c6cbbf37efff00` | `0x8B184b21779d6D8260f81336536d423234F0eD96` | `0xe38490844235179936e7b8f69ee71d4fa2586aa5607b0bde4f0336b3288158b8` |

Reads after the deploy (both chains identical): code 5575 bytes; `mint_id()` = `0x772f7b51...91b3` (the tROME mint);
`name()` = "Rome (test)"; `symbol()` = "tROME"; `decimals()` = 9; `totalSupply()` = 1000000000000000000 (1e9 tokens at 9 decimals
scaled to 18, matching the mint supply); `factory.token_by_mint(mint)` returns the wrapper; `wrapper_kind_by_mint(mint)` = 1 (cached).

One-unit transfer from the signer `0x1f4946Be340F06c46A50E65084790968aBcc48F6` to `0x...dEaD`, run the way rome-solidity #384
did it: first the one-time `HelperProgram.approve_spl(wrapper, 2^64-1, mint)` grant (sent to `0xff00...0009`), then
`transfer(0x...dEaD, 1)` (gas limit = estimate x 1.3, legacy tx at 2x gas price). The lead funded the signer with 10 tROME on
each chain beforehand (`balanceOf` = 10000000000 on both wrappers). Balances read before and after:

| Chain | approve_spl tx | transfer tx | signer before -> after | recipient before -> after |
|---|---|---|---|---|
| Hadrian 200010 | `0xaf240096e27ca25ed1ac6918e3fd09c5f01f7af61b3c355e98db280c7db8aa29` | `0x1a1f643f3ca43ca005d020439a9fde25e16c0d8f0e321333bc81a00de1946835` | 10000000000 -> 9999999999 | 0 -> 1 |
| Martius 121214 | `0x5ed69327425d9834c6d824f54d06dd1167bf19f9b8ea88a289a7a08b23c4a6df` | `0xc410c4f7c442e8453a176fe9867e29ad3219937b8d3c0125930d23d52f95e830` | 10000000000 -> 9999999999 | 0 -> 1 |

All four transactions have status success. Signer down by 1 and recipient up by 1 on both chains.
