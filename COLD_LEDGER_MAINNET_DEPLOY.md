# Cold-Ledger Mainnet Deploy — rome-solidity (Hardhat 3 + viem)

Scaffold for moving mainnet (`rubicon`, chain **7531**) Solidity deploys off the hot-key to a cold Ledger.
Branch: `mainnet-cold-ledger-deploy-solidity`. **IMPLEMENTED + devnet-validated (2026-06-16):** viem Ledger adapter `scripts/lib/ledger.ts` + unified `getDeployer` `scripts/lib/deployer.ts` (Ledger or hot key, reads artifacts from FS) + entrypoint `scripts/deploy-ledger.ts`. ERC20SPLFactory was deployed via the Ledger on trajan (chain 121302) at `0x7659efa8898928b042ff6bbde2adb45c3a0c27cd`.

**Run:** `npx hardhat compile && DEPLOY_VIA_LEDGER=1 ROME_RPC_URL=<rpc> ROME_CHAIN_ID=<id> npx tsx scripts/deploy-ledger.ts`. The Ledger path MUST run under **`tsx`**, not `hardhat run` (Hardhat's CJS script runner hits an ESM require-cycle in `@ledgerhq`). `scripts/deploy-ledger.ts` currently deploys ERC20SPLFactory; remaining Phase-6 contracts extend it with the same `deployer.deploy(<name>, [args])` pattern (library-linked contracts need link handling added to `getDeployer`).

## Current mechanism (verified)
- Stack: Hardhat 3 (`hardhat ^3.9.0`) + viem (`@nomicfoundation/hardhat-toolbox-viem ^5.0.7`) — `hardhat.config.ts:1,5`.
- Per network: `{ chainId, url, accounts: [configVariable("<NET>_PRIVATE_KEY")] }` — `hardhat.config.ts:24-44`.
- Deploy scripts sign via `const [deployer] = await viem.getWalletClients();` (e.g. `scripts/deploy_erc20spl_factory.ts:33`) — `deployer` is a viem WalletClient bound to the network's first private key.

## Risk being fixed
Plaintext key in env at deploy time. On mainnet the deployer **is** the contract admin (Ownable owner, factory admin, paymaster/bridge authority). Key compromise = contract takeover. Cold Ledger keeps the admin key in hardware.

## Recommended approach — viem-native (no hardhat-ledger dependency)
HH3+viem has no first-class Ledger plugin (`@nomicfoundation/hardhat-ledger` is ethers/HH2-oriented — see Open items). Build the signer in-script:

1. **Deps** (⚠️ GATED — `npm install` fetches external; run in the focused session): `@ledgerhq/hw-app-eth`, `@ledgerhq/hw-transport-node-hid`.
2. **Ledger-backed viem account** — `scripts/lib/ledgerAccount.ts`:
   - `const transport = await TransportNodeHid.create(); const eth = new AppEth(transport);`
   - Wrap with viem `toAccount({ address, signTransaction, signMessage, signTypedData })`, delegating to `eth.signTransaction` / `eth.signPersonalMessage` / `eth.signEIP712Message`. Derivation path operator-confirmed (e.g. `m/44'/60'/0'/0/0`).
3. **`getDeployer()` helper** — returns the Ledger wallet client when `DEPLOY_VIA_LEDGER=1`, else `(.getWalletClients())[0]` (devnet/testnet keep the hot-key path):
   ```ts
   const account = await makeLedgerAccount(process.env.LEDGER_PATH ?? "m/44'/60'/0'/0/0");
   return createWalletClient({ account, chain: rubicon, transport: http("https://rubicon.romeprotocol.xyz") });
   ```
   Swap the ~10 deploy scripts from `viem.getWalletClients()` → `getDeployer()`.
4. **hardhat.config.ts** — add rubicon: `rubicon: { type: "http", chainId: 7531, url: "https://rubicon.romeprotocol.xyz/", accounts: [] }` (empty — signing is in-script).
5. **Device** — Ethereum app, enable **blind signing** (chain 7531 is unknown to the device, so contract deploys require it). One physical tap per tx.

## Deploy set (tap-count driver) — order per `rome-ops/scripts/deploy-solidity.sh` Phase 6
1. `scripts/deploy_erc20spl_factory.ts`
2. `scripts/bridge/bootstrap-bridged-wrappers.ts`
3. `scripts/bridge/deploy.ts` (paymaster + SPL_ERC20 wrappers + withdraw)
4. `scripts/oracle/deploy-v2-polish.ts` (+ `scripts/oracle/deploy-seed-feeds.ts`)
5. `scripts/deploy_meteora_factory.ts` (+ `scripts/deploy_meteora_router.ts`)
6. Romeswap → **rome-uniswap-v2** (separate repo + ethers stack; see that worktree's doc)
7. `scripts/activation/deploy-simple-activator.ts`

Several are multi-contract → expect **~20-40 Ledger taps**. Budget time + a charged device.

## Devnet rehearsal (needs physical Ledger)
Point `DEPLOY_VIA_LEDGER=1` at a devnet chain (trajan, 121302): deploy `deploy_erc20spl_factory.ts` + 1-2 more via the Ledger. Confirms the viem-Ledger account, blind-sign UX, tx count, gas — before mainnet.

## Open / gated
- ⚠️ `npm install` (external) — gated.
- ⚠️ `@nomicfoundation/hardhat-ledger` HH3+viem support uncertain (built for HH2/ethers). In-script viem approach avoids depending on it.
- ⚠️ Physical Ledger required to implement + test.
- Derivation path + device — operator to confirm (distinct Ethereum-app key vs the Solana program-authority key).

## Signer mechanism — decision (2026-06-16; approach devnet-verified)
The three Ledger-signing options are not interchangeable for the full stack deploy:
- **viem in-script Ledger account (this repo) = PRIMARY.** Deploy keeps running through the existing tested TS scripts; only the signer changes. Match the repo's native stack (viem here; ethers in rome-uniswap-v2) — do not rewrite to unify (all paths emit the identical signed EIP-1559 tx the proxy accepts).
- **`cast send --ledger` = VALIDATED FALLBACK.** Devnet-verified end-to-end 2026-06-16: a Ledger signed an EIP-1559 contract-creation on trajan (121302); the proxy accepted it (contract `0x35c6878c82C03f6773bf8c3eF0C3bBaF73D56a1B`, status success). Zero-install. Use for one-off redeploys / emergencies, or if hardhat-ledger HH3 support proves painful. Do not drive all of Phase 6 through cast (reimplements orchestration + diverges mainnet from the devnet-tested scripts).
- **Pre-flight (learned in the rehearsal): enable Blind signing on the Ledger Ethereum app** — an unknown chain id otherwise returns APDU `6a80 INVALID_DATA` on every deploy tap.
