# Rome Bridge — Deploy Scripts

Deploy and ops scripts for the Rome Bridge contracts: paymaster (legacy), SPL_ERC20 wrappers (`WUSDC`, `WETH`, `WSOL`, plus per-asset `W{Symbol}` deploys), and `RomeBridgeWithdraw`.

Token nomenclature follows the canonical W-prefix standard.

**Read `contracts/bridge/README.md` first** — it covers the architecture, the four bridge flows, and the non-obvious problems that shaped the design (single-tx compute-budget limit, missing SPL Approve, stale canonical mints, etc.). This file is the operational companion.

## Deploy scripts

- `constants.ts` — canonical Solana program IDs (mainnet + devnet), SPL mint pubkeys, CCTP domains, Wormhole chain IDs. `SPL_MINTS_DEVNET.WETH_WORMHOLE` must match the canonical wrapped-ETH mint for the Ethereum chain you are bridging from.
- `deploy.ts` — deploys `RomeBridgeWithdraw` 13.0.0 against the existing USDC wrapper (`USDC_MINT` required). It deploys with **no CCTP domain and empty Wormhole lists**: the owner switches those on afterwards. `BRIDGE_OWNER` and `BRIDGE_GUARDIAN` set the owner and the stop-only guardian (the owner defaults to `WORMHOLE_ADMIN`, then the deployer; the guardian defaults to none and must differ from the owner). Reads back version, owner, guardian and the empty domain list before it writes `deployments/{network}.json`. **Testnets only: it refuses to send unless the RPC reports a listed testnet chain id, so it cannot deploy on Rubicon.** The Rubicon deploy of 13.0.0 is `deploy-rubicon-v13.ts` (next entry); `scripts/deploy-ledger.ts` only deploys `ERC20SPLFactory`. Both scripts build the constructor arguments with `lib/withdraw-ctor-args.ts`.
- `deploy-rubicon-v13.ts` — the Rubicon (chain 7531) deploy of `RomeBridgeWithdraw` 13.0.0, owner = the cold Ledger and guardian = the ops key from construction (no hand-over). `--network <name> --owner <address> --guardian <address> [--dry-run | --deploy <digest> | --verify-existing <address> --deploy-tx <hash> --source-commit <sha>] [--owner-differs-from-v12] [--i-understand-mainnet]`, run with `npx tsx`; it compiles first on every run and checks the artifact's build-info against the files on disk. Both addresses are required, with no defaults; the call is refused when either is zero, they are equal, or either is the deploy key (the hot key behind the network's `RUBICON_PRIVATE_KEY`, never printed). On Rubicon: `--i-understand-mainnet` is required for every run; a run without `--deploy` is a DRY RUN (estimates gas at the pinned `RUBICON_GAS_PRICE`, prints the deploy transaction, the constructor arguments, the commit, the deploy key's nonce and the address the deploy will create, the deploy input hash, v12's owner beside `--owner`, and a deploy digest; sends nothing); the real deploy needs `--deploy <digest>` with the digest that dry run printed, which covers the bytecode, the constructor arguments, the chain, the deploy key and its nonce (so it goes stale as soon as the deploy key sends anything); `--owner` and `--guardian` must be EIP-55 checksummed accounts with no code, the owner must hold gas, `RUBICON_GAS_PRICE` must be set, `contracts/`, `hardhat.config.ts` and `package-lock.json` must be clean in git, the artifact must be built from exactly those sources, and `--owner` must be v12's `owner()` and `--guardian` must not be (a real deploy with another owner, or with no valid v12 address in `deployments/rubicon.json`, or with a v12 `owner()` that cannot be read, needs `--owner-differs-from-v12`; the swap is always refused), the npm dependencies the compiler read must be the lockfile's own published packages (the script downloads and compares them), and the deployments file lock is never taken over: if `deployments/rubicon.json.lock` exists, confirm that no other run is active and remove it by hand. A real run deploys, reads back version, owner, pending owner, guardian, the empty CCTP list, the unpaused rails, the USDC wrapper and mint, the empty Wormhole lists and the deploy key's lack of any role (retried for RPC lag; a wrong value fails at once, loudly, and nothing is recorded), checks that the transaction that was mined is the approved deploy, writes `deployments/<network>.json` (atomically) under `RomeBridgeWithdrawV13` with the commit, the build, `codeHash`, `deployInputHash` and the deploy block's time (the live v12 `RomeBridgeWithdraw` record is not touched), and PRINTS the owner calls for the Ledger: `ensureBridgeAta(<USDC mint from the record>)` first, then `enableCctpDomain(0, 1)`. It never sends them. `--verify-existing` (with `--deploy-tx` and `--source-commit`, the commit the deploy was run from) reads back and records a contract that already landed, after checking the transaction was the deploy key's creation of that address with exactly these bytes and that the commit's sources equal this checkout's; it sends nothing. Logic and tests: `lib/rubicon-v13.ts`, `lib/build-provenance.ts`, `tests/bridge/deploy-rubicon-v13.test.ts` (local Hardhat only). Procedure: "Rubicon deploy of 13.0.0" below.
- `enable-cctp-domains.ts` — `--network <name> --domains 0,1,3,6:evm,8:raw32` (or `--registry <bridge.json>`: every `sourceEvms[]` entry with a `cctpDomain` that is `live` or `preparing`): reads the live `cctpDomains()`, diffs it against the wanted list in both directions, and **prints** the target address and calldata of each `enableCctpDomain` / `disableCctpDomain` call, with a dry run from the owner and the Circle account the contract will derive. It sends only with `--send`, only on a network it knows, only when the chain id the RPC reports is on the testnet allowlist (`lib/testnet-guard.ts`: Rubicon 7531 and any unlisted id are refused), only when `<NETWORK>_PRIVATE_KEY` is the contract's owner; Rubicon is print-only under any name. A domain the contract refuses (5 Solana, 17 BNB, 27 Stellar) is rejected in `--domains` and `--registry`. `--registry` merges the older `sourceEvm` with `sourceEvms[]` (one chain once, by `chainId`). `--check` exits 1 when the chain differs from the list, or when Circle's live account of an enabled domain no longer passes the contract's checks (`--solana-rpc` or `SOLANA_RPC_URL`). Pure helpers and tests in `lib/cctp-domain-plan.ts`.
- `redeploy-withdraw-devnet-wh.ts` — redeploy only the withdraw contract against devnet Wormhole programs; reuses paymaster + wrappers.
- `redeploy-withdraw-canonical-weth.ts` — redeploy withdraw + new WETH wrapper bound to the canonical wrapped-ETH mint (used when refreshing on a chain where the WETH wrapper still points at a stale mint).
- `redeploy-withdraw-only.ts` — gone since #227 (with the other `redeploy-withdraw-*` scripts); no script in this repo deploys `RomeBridgeWithdraw` on mainnet.
- `deploy-weth-v9.ts`, `deploy-wsol-v9.ts` — minimal SPL_ERC20 wrapper redeploys carrying the v9 outbound surface (`bridgeOutToSolana` + `ensureRecipientAta` + `balanceOf` reads from AUTHORITY_PDA). Use these to refresh wrappers on a chain after the contract upgrade. They do not touch the factory or paymaster.
- `ensure-bridge-atas.ts` — v10 rollout step 3, OWNER-only: `ensureBridgeAta(mint)` once per bridged mint before its first burn (`transfer_spl_from_ata` has no create leg; the ATA is paid from operator rent, hence owner-gated). Reads the bridge from `deployments/{network}.json`, the mints from its `SPL_ERC20_*` wrappers (or `BRIDGE_ATA_MINTS`), the bridge PDA from the HelperProgram `pda()` view; checks each ATA on Solana first (skip if present) and reads it back after the call. `DRY_RUN=1` reports without writing. Run from `contract-deploys/bridge-ensure-ata.yml` (owner key lives in the GitHub Environment). Pure helpers + tests in `lib/ensure-bridge-atas.ts`.
- `derive/cctp-accounts.ts` — derives the CCTP PDAs via `PublicKey.findProgramAddressSync`, and `deriveRemoteTokenMessenger(domain)` (Circle's per-domain account, which the v13 contract derives on chain too).
- `derive/wormhole-accounts.ts` — derives the Wormhole PDAs. `deriveWormholeGlobalAccounts` is the mint-independent set the v13 constructor takes; `deriveWormholeAccounts` adds the per-mint custody and `wrappedMeta`.
- `lib/canonical-mint.ts` — derives the canonical wrapped-ETH mint from `(tokenChain, tokenAddress, tokenBridgeProgramId)` per Wormhole's seed scheme. Always use this to resolve the wETH mint rather than hard-coding.
- `lib/verify-mint-on-chain.ts` — verifies the derived mint exists on Solana.

## Flow / test scripts

- `lib/testnet-guard.ts` — the one gate every sending script goes through: it reads the chain id the RPC reports (never the network name) and refuses unless it is a listed testnet; Rubicon (7531), unlisted ids and silent RPCs are refused, with no flag to override, except for the one script `deploy-rubicon-v13.ts`, which may touch 7531 only with `--i-understand-mainnet` (`assertRubiconV13DeploySend`: it compares the calling script's own path AND the file the process was started as (`argv[1]`), the script's send step calls it itself, and tests fail if any other file uses it or imports the script). A local Rome stack is allowed by listing its id in `ROME_EXTRA_TESTNET_CHAIN_IDS` (mainnet ids are refused even there). The inbound Solana scripts check the Solana genesis hash (devnet or testnet only). The `.mjs` scripts import the `.ts` guard directly and need Node 22.18+; if it cannot load they do not run. A test scans `scripts/bridge` and fails if a script with a send site does not call the guard. Mainnet is print-only (`enable-cctp-domains.ts`) or refused (everything else); the Rubicon deploy is `deploy-rubicon-v13.ts`.
- `submit-burn.ts` — outbound CCTP test: single `burnUSDC(amount, recipient)` tx on Rome, testnet only. The recipient is the signer's own address unless `BURN_RECIPIENT` is set (zero and burn-like addresses are refused; the old version burned to `0x...0001` and lost the tokens); `BURN_AMOUNT` sets base units (default 100000).
- `outbound-wh-e2e.ts` — outbound Wormhole E2E: sends `approve_spl(bridge, amount, mint)` direct to `0xff..09` (the bridge's pull-delegate precondition), then `burnToWormhole(wrapper, amount, recipient, targetChain)`. (`burnETH` and `submit-burnETH.ts` are gone in 13.0.0.) Needs the owner to have allowed the mint and the chain with `set-wormhole-allowlist.ts`.
- `smoke-emulate-all.ts` — quick `rome_emulateTx` health check for `burnUSDC` and the `approve_spl` precondition. `burnToWormhole` is skipped because it needs that delegate already live on-chain to emulate cleanly.
- `inbound/` — scripts for Sepolia → Rome inbound flows (CCTP deposit, Wormhole transfer, manual VAA complete).
- `try-burn.ts`, `smoke-test-canonical.ts` — legacy integration helpers used during initial bring-up; kept for reference. `try-burn.ts` follows the same recipient and testnet rules as `submit-burn.ts`.

## Usage

### Local

Requires `the local dev stack/deploy/start-local.sh` running. CCTP + Wormhole programs must be present in the local Solana cluster (they're seeded by the local dev stack; if you see deploy errors referencing unknown programs, verify your local stack seeded them).

```bash
npx hardhat keystore set LOCAL_PRIVATE_KEY --dev
npx hardhat run scripts/bridge/deploy.ts --network local
```

## Rubicon deploy of 13.0.0

Owner = the cold Ledger and guardian = the ops key, from construction. Nothing here sends an owner call: the Ledger does.

1. **Fund the cold Ledger with Rubicon gas.** The Ledger (`--owner`) signs the two owner calls in step 7, so it needs gas on Rubicon; the script refuses a real deploy while the owner holds none. The deploy key is separate (a hot key, `RUBICON_PRIVATE_KEY` in the Hardhat keystore or the environment, never printed) and needs gas for the deploy only. The ops key (`--guardian`) needs nothing now. The three addresses must all differ. Copy `--owner` and `--guardian` with their EIP-55 checksums (mixed case): an all-lowercase address is refused on Rubicon. Both must be plain accounts with no contract code.
2. **Dry run.** Start from a FRESH clone of the reviewed commit, run `npm ci` in it (never `npm install`, never a reused or hand-edited `node_modules`), and pin a gas price. `git status --porcelain contracts/ hardhat.config.ts package-lock.json` must be empty. The script compiles itself, on every run, and then checks the artifact's build-info against the files on disk, so there is no separate compile step to forget. On Rubicon it also downloads, for every npm package the compiler read (today `@openzeppelin/contracts`), the tarball `package-lock.json` locks (registry.npmjs.org only), requires its sha512 to equal the lockfile's integrity, and compares every compiler-input file byte for byte with the tarball's own file: a patched `node_modules` with an unchanged lockfile is refused, so the bytecode is provably the reviewed commit's sources plus the locked dependencies' published files. This needs network access to the npm registry (one request per package). On Rubicon a run without `--deploy` is a dry run, so this command sends nothing:

   ```bash
   export RUBICON_GAS_PRICE=$(( $(cast gas-price -r <rpc>) * 11 / 10 ))
   npx tsx scripts/bridge/deploy-rubicon-v13.ts --network rubicon \
       --owner <ledger address> --guardian <ops key address> --i-understand-mainnet
   ```

   Read the printed owner (next to v12's `owner()`: the script refuses a real deploy when they differ, and refuses outright when `--guardian` is v12's owner, which is the owner and guardian pasted the wrong way round), guardian, USDC wrapper and mint against the registry, and the commit against the reviewed one. The dry run prints the deploy key's **nonce**, the **address the deploy will create**, a **deploy digest** and the estimated cost at the pinned gas price. `--i-understand-mainnet` is required for every run on Rubicon, and `--owner` and `--guardian` have no default.
3. **Deploy.** The same command with `--deploy <digest>`, using the digest the dry run printed. The script refuses any other digest, and the digest changes if the bytecode, the owner, the guardian, the chain, the deploy key or the deploy key's nonce change, so the deploy sends exactly what the dry run showed and a deploy that already landed makes the old digest stale. If the run stops with "is locked", `deployments/rubicon.json.lock` exists: the script never takes a lock over, so confirm no other run is active (`ps`, `cast nonce <deploy key>`), remove the file by hand and run again. The constructor sets the owner and the guardian directly, so there is no hand-over. The Wormhole lists and the CCTP list start empty. The send passes the approved nonce to the wallet explicitly, and the record is written only if the mined transaction used that nonce and created the predicted address; otherwise nothing is recorded and the error says what to check (`cast tx`, `cast nonce`, `cast code`) before anything else. If the deploy landed but the script stopped (a read-back that failed on a transient RPC error, a receipt that timed out, a file that could not be written), do not deploy again: run the same command with `--verify-existing <address> --deploy-tx <hash> --source-commit <the commit you deployed from>` instead of `--deploy`. It checks that the transaction is the deploy key's creation of that address with exactly these bytes and that the commit's contracts, config and lockfile equal this checkout's, reads it back, records it and prints the owner calls. If the send itself printed an RPC error (a gateway timeout, a 502) the transaction MAY have landed: before anything else run `cast nonce <deploy key>` (one more than the printed nonce means it landed) and `cast code <the predicted address>`; if it landed, find the creation transaction of that address and use `--verify-existing`; if it did not, run the dry run again for a fresh digest.
4. **Read-back.** The script reads the new contract (retrying a lagging node a few times) and fails loudly on any wrong value: `VERSION()` is `13.0.0`, `owner()` is the Ledger, `pendingOwner()` is zero, `guardian()` is the ops key, `cctpDomains()` is empty, no rail is paused, the USDC wrapper and mint are the ones in `deployments/rubicon.json`, both Wormhole lists are empty, and the deploy key holds no role. A contract that fails is not recorded: do not use it. On success the script writes `deployments/rubicon.json` under a new key, `RomeBridgeWithdrawV13`, with the commit, the build (build-info id and solc version), `codeHash` (keccak256 of `eth_getCode`, taken after the read-back), `deployInputHash` (keccak256 of the deploy transaction's input) and `deployedAt` (the deploy block's time), and leaves the live v12 `RomeBridgeWithdraw` record alone. Commit that file change.
5. **Verify the source** with `scripts/verify-deployments.sh rubicon` (Rubicon's own Sourcify), as for any deploy. Then check the record against the chain itself, with the Rubicon RPC (the local artifact's runtime bytecode cannot be compared: the constructor writes the 27 immutables into the deployed code, so only the chain's own code matches):

   ```bash
   cast keccak $(cast code <address> -r <rubicon rpc>)          # must equal codeHash in deployments/rubicon.json
   cast keccak $(cast tx <deployTx> input -r <rubicon rpc>)     # must equal deployInputHash (and the dry run's "deploy input hash")
   ```

   `<address>` and `<deployTx>` are the `address` and `deployTx` of `RomeBridgeWithdrawV13` in the same file. Both commands must print exactly the recorded value; if either differs, stop and do not go on to step 6.
6. **Pin every consumer BEFORE the registry publish.** The registry `--supersedes` publish (step 8) marks v12 `deprecated` and v13 `live` in one go, and `rome-bridge-api` resolves the first `live` entry (registry CHANGELOG v0.23.9). Any consumer that reads the registry would move to v13 before the real send in step 10. So pin `rome-bridge-api` (and any other reader) to the v12 address first, with the new feature switch OFF, or move the registry publish to after the real send.
7. **The two Ledger calls.** The script prints, and never sends, the target, calldata and a description of each call. The Ledger signs and sends them in this order, and the order matters:
   1. `ensureBridgeAta(<Rubicon USDC mint>)`: the bridge's USDC token account (the mint is `SPL_ERC20_USDC.mintId` in `deployments/rubicon.json`). Sign this first, so the CCTP rail is never open on a bridge with no token account (a burn would revert).
   2. `enableCctpDomain(0, 1)`: Ethereum (Circle domain 0) as an EVM destination.

   The Wormhole allowlists stay empty: there is no call for them. Afterwards `npx tsx scripts/bridge/enable-cctp-domains.ts --network rubicon --domains 0 --check --address <new bridge>` should report in sync.
8. **Registry.** With the consumers pinned (step 6), add the new address as a new bridge entry with `--supersedes` pointing at the v12 entry, in the registry's own tooling; the v12 record stays until the switch-over is done. This is a separate step and a separate change, and the registry keeps both versions so claims on v12 burns still resolve.
9. **bridge-api pin to v13, switches OFF.** Pin `rome-bridge-api` to the new address with the new feature switch OFF, deploy, and check the live environment. Switch it ON only on its own go.
10. **A real 1 USDC send.** With the switch ON, send a real 1 USDC burn from Rubicon through the new bridge and confirm it lands within the hour, before anything else moves. If it does not, switch OFF.

The release gates above (bridge-api route, claim discovery across versions, the Hadrian proof) come first.

## Testing

Unit tests (run on hardhatMainnet, no Rome stack needed):

```bash
npx hardhat test tests/bridge/RomeBridgePaymaster.test.ts --network hardhatMainnet
npx hardhat test tests/bridge/RomeBridgeWithdraw.test.ts --network hardhatMainnet
npx hardhat test tests/bridge/derive.test.ts --network hardhatMainnet
npx hardhat test nodejs tests/bridge/deploy-rubicon-v13.test.ts tests/bridge/testnet-guard.test.ts
```

Integration tests (require live Rome stack + pre-seeded user balances):

```bash
npx hardhat test tests/bridge/RomeBridgeWithdraw.integration.ts --network local
# or against the live devnet
npx hardhat test tests/bridge/RomeBridgeWithdraw.integration.ts --network <chain>
```

## Adding a new asset

The path differs by asset origin:

### Solana-native SPL (any token deployed via the factory) — outbound only

For tokens that originate on Solana (USDT-on-Solana, JUP, BONK, custom long-tail, etc.), you only need an `SPL_ERC20` wrapper on Rome. No `RomeBridgeWithdraw` change, no new burn entrypoint, no paymaster allowlist update — `SPL_ERC20.bridgeOutToSolana` is the generic outbound for all of them.

1. Call `ERC20SPLFactory.add_spl_token_no_metadata(mint, "Symbol", "Name")` against the deployed factory on the target chain.
2. The backend's `TokenCreated` event indexer picks up the new wrapper and surfaces it in `the app`'s portfolio + bridge picker. The bridge picker auto-includes it because `useRomeHoldings` filters on `kind === "wrap"`.

That's it. One CPI per outbound transfer, same code path as WETH/WSOL today.

### Ethereum-origin asset — inbound + outbound, requires Solidity work

For tokens that originate on Ethereum (USDC, ETH, future ERC20s reaching Rome through CCTP/Wormhole), the outbound path needs a per-asset entry on `RomeBridgeWithdraw`:

1. Add the mint base58 to `constants.ts` under `SPL_MINTS`.
2. Add a `deploySplErc20` call in `main()` for the new symbol.
3. Extend `RomeBridgeWithdraw` with a new `burnXYZ` entry point that CPI-invokes the right Solana program (Wormhole or CCTP).
4. Register the new selector via `RomeBridgePaymaster.setAllowlistEntry`.
5. Inbound side: ensure a Wormhole attestation exists between the source chain and the target Solana cluster (one-time `attestToken` + `create_wrapped`). For CCTP, no attestation is needed — Circle handles all USDC.

## Verifying PDA derivations

Both CCTP and Wormhole programs publish their seed schemes. Before first deploy on a new cluster, cross-check each PDA in `derive/*.ts` against:

- CCTP IDL: https://developers.circle.com/stablecoins/docs/cctp-on-solana
- Wormhole Token Bridge IDL: https://github.com/wormhole-foundation/wormhole/blob/main/solana/modules/token_bridge/idl

The 14 PDAs derived (6 CCTP + 8 Wormhole) are deterministic given the program IDs and the mint. Deterministic test coverage lives in `tests/bridge/derive.test.ts`.
