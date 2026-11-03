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

One-unit transfer: NOT run. The tROME balance sits on the Solana deployer wallet, and the signer's EVM identity on each chain
(`0x1f49...48F6`) holds 0 tROME (`balanceOf` = 0 on both wrappers). Moving tROME into that identity's token account needs the
Solana deployer's key, which was not available to this run. To prove the transfer: send some tROME from the Solana deployer to
the signer's Rome token account on each chain, grant `HelperProgram.approve_spl(wrapper, 2^64-1, mint)`, then transfer 1 unit
and read both balances before and after.
