// scripts/bridge/bootstrap-bridged-wrappers.ts
//
// Registers the canonical bridged-asset SPL mints (USDC, WETH, ...) on the
// chain's LIVE named wrapper factory (ERC20SPLNamedFactory), through its
// metadata path (`add_spl_token_with_metadata`). Run once after the named factory is live on
// a chain — the resulting `TokenCreated` events are what the the Rome app
// backend's token watcher consumes to populate Portfolio / Swap /
// TokenSelectModal. Wrappers deployed via direct `new SPL_ERC20(...)` bypass
// this event and never appear in the UI.
//
// Nobody chooses a name here. A wrapper's name and symbol are the naming rule applied
// to the metadata the mint itself carries (the origin's own name and symbol, unchanged), as
// the named factory's `preview` reports them. A mint the named factory refuses (on the grandfather list, no
// name of its own, a metadata pointer it does not accept, a name or symbol its
// checks refuse) is skipped with the reason and registered under no other name.
// A chain with no live named factory, and any factory the chain's record marks deprecated,
// is refused before anything is sent (scripts/lib/wrapper-factory.ts).
//
// Idempotent: records mints that already have a wrapper
// (`factory.token_by_mint(mint) != 0`). A deployments slot that already holds a different (legacy) wrapper is
// never overwritten: the named factory's wrapper is recorded under `<slot>_NAMED`.

import fs from "node:fs";
import { isSolanaDevnetNetwork } from "./lib/wormhole-target-chain.js";
import hardhat from "hardhat";
import { assertTestnetSend } from "./lib/testnet-guard.js";
import { resolveLiveNamedFactory } from "../lib/wrapper-factory.js";
import { planEntry, previewOutcome, recordKey } from "./lib/bootstrap-plan.js";
import { base58ToBytes32 } from "../lib/pubkey.js";
import { SPL_MINTS_DEVNET, SPL_MINTS_MAINNET, COMPOUND_COLLATERAL_MINTS_DEVNET, LST_MINTS_DEVNET, TROME_MINT_DEVNET } from "./constants.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type WrapperSpec = {
  slot: string;         // the deployments.json entry (e.g. "SPL_ERC20_USDC")
  mintBase58: string;   // SPL mint
};

// Canonical bridged set. The name and symbol of each wrapper are the named factory's, from
// the mint's own metadata; this table names no one. Tracked separately for
// devnet / mainnet because the mint addresses differ.
const DEVNET_SET: WrapperSpec[] = [
  { slot: "SPL_ERC20_USDC", mintBase58: SPL_MINTS_DEVNET.USDC_NATIVE },
  { slot: "SPL_ERC20_WETH", mintBase58: SPL_MINTS_DEVNET.WETH_WORMHOLE },
  { slot: "SPL_ERC20_WSOL", mintBase58: SPL_MINTS_DEVNET.WSOL_NATIVE },
];

const MAINNET_SET: WrapperSpec[] = [
  { slot: "SPL_ERC20_USDC", mintBase58: SPL_MINTS_MAINNET.USDC_NATIVE },
  { slot: "SPL_ERC20_WETH", mintBase58: SPL_MINTS_MAINNET.WETH_WORMHOLE },
  { slot: "SPL_ERC20_WSOL", mintBase58: SPL_MINTS_MAINNET.WSOL_NATIVE },
];

// Compound-collateral wrapper set (devnet-substrate chains only). Mirrors the
// 6 exotic collaterals of Hadrian's canonical 9-asset Comet — the same
// underlying devnet mints — so a Comet deployed on any devnet-substrate chain
// can carry the full asset suite. Select with
// `WRAPPER_SET=collateral`; the default run keeps the canonical bridged set.
const COLLATERAL_SET_DEVNET: WrapperSpec[] = [
  { slot: "SPL_ERC20_WBTC",     mintBase58: COMPOUND_COLLATERAL_MINTS_DEVNET.BTC_TEST },
  { slot: "SPL_ERC20_WJITOSOL", mintBase58: COMPOUND_COLLATERAL_MINTS_DEVNET.JITOSOL_TEST },
  { slot: "SPL_ERC20_WMSOL",    mintBase58: COMPOUND_COLLATERAL_MINTS_DEVNET.MSOL_TEST },
  { slot: "SPL_ERC20_WJUP",     mintBase58: COMPOUND_COLLATERAL_MINTS_DEVNET.JUP_TEST },
  { slot: "SPL_ERC20_WJTO",     mintBase58: COMPOUND_COLLATERAL_MINTS_DEVNET.JTO_TEST },
  { slot: "SPL_ERC20_WBONK",    mintBase58: COMPOUND_COLLATERAL_MINTS_DEVNET.BONK_TEST },
];

// Hadrian restore set: the wrappers the 2026-09 rotation (factory 9.0.0) did not
// recreate, on the same mints. The Marinade test mint has no Metaplex metadata, so
// the named factory refuses it (no name of its own: it is not carried) and the run skips it.
// Select with `WRAPPER_SET=hadrian-restore`.
const HADRIAN_RESTORE_SET: WrapperSpec[] = [
  { slot: "SPL_ERC20_MSOL",     mintBase58: LST_MINTS_DEVNET.MSOL_MARINADE },
  { slot: "SPL_ERC20_WJITOSOL", mintBase58: LST_MINTS_DEVNET.JITOSOL_WORMHOLE },
  { slot: "SPL_ERC20_WBTC",     mintBase58: COMPOUND_COLLATERAL_MINTS_DEVNET.BTC_TEST },
  { slot: "SPL_ERC20_WJUP",     mintBase58: COMPOUND_COLLATERAL_MINTS_DEVNET.JUP_TEST },
  { slot: "SPL_ERC20_WBONK",    mintBase58: COMPOUND_COLLATERAL_MINTS_DEVNET.BONK_TEST },
];

// tROME wrapper set: the devnet test copy of the ROME token, so EVM users can trade
// it too, named from the mint's Metaplex metadata. Select with
// `WRAPPER_SET=trome` (hadrian, martius).
const TROME_SET: WrapperSpec[] = [
  { slot: "SPL_ERC20_TROME", mintBase58: TROME_MINT_DEVNET },
];

// Which mint set a network gets follows the Solana cluster it settles on — the
// ONE set in lib/wormhole-target-chain.ts (shared with deploy.ts's program-id
// and Wormhole target-chain choice). Rome network tier ≠ Solana cluster: the
// Rome-testnet chains (martius, nerva) run on Solana DEVNET. Override via
// `BRIDGED_SET=devnet|mainnet` for one-off cases.

function resolveSet(networkName: string): WrapperSpec[] {
  const wrapperSet = process.env.WRAPPER_SET?.toLowerCase();
  if (wrapperSet === "hadrian-restore") {
    // The LST mints and the collateral test mints exist only on Solana devnet.
    const override = process.env.BRIDGED_SET?.toLowerCase();
    if (override === "mainnet" || (override !== "devnet" && !isSolanaDevnetNetwork(networkName))) {
      throw new Error(
        `WRAPPER_SET=hadrian-restore is devnet-substrate-only (network '${networkName}' resolves to mainnet mints)`,
      );
    }
    return HADRIAN_RESTORE_SET;
  }
  if (wrapperSet === "trome") {
    // The tROME mint exists only on Solana devnet.
    const override = process.env.BRIDGED_SET?.toLowerCase();
    if (override === "mainnet" || (override !== "devnet" && !isSolanaDevnetNetwork(networkName))) {
      throw new Error(
        `WRAPPER_SET=trome is devnet-substrate-only (network '${networkName}' resolves to mainnet mints)`,
      );
    }
    return TROME_SET;
  }
  if (wrapperSet === "collateral") {
    // Collateral test mints exist only on Solana devnet — refuse a mainnet run.
    const override = process.env.BRIDGED_SET?.toLowerCase();
    if (override === "mainnet" || (override !== "devnet" && !isSolanaDevnetNetwork(networkName))) {
      throw new Error(
        `WRAPPER_SET=collateral is devnet-substrate-only (network '${networkName}' resolves to mainnet mints)`,
      );
    }
    return COLLATERAL_SET_DEVNET;
  }
  const override = process.env.BRIDGED_SET?.toLowerCase();
  if (override === "devnet")  return DEVNET_SET;
  if (override === "mainnet") return MAINNET_SET;
  return isSolanaDevnetNetwork(networkName) ? DEVNET_SET : MAINNET_SET;
}

type DeploymentsJson = Record<string, unknown>;

function loadJson(path: string): DeploymentsJson {
  return fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) as DeploymentsJson : {};
}

function saveJson(path: string, data: DeploymentsJson): void {
  fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function main() {
  const { viem, networkName } = await hardhat.network.connect();
  const [deployer] = await viem.getWalletClients();
  if (!deployer?.account) throw new Error("No deployer wallet — set <NETWORK>_PRIVATE_KEY in the keystore");

  // The chain's live named factory, or a refusal before anything is sent. An address handed in through
  // ERC20_SPL_FACTORY_ADDRESS must be that same factory: a legacy one is refused.
  const factoryAddress = resolveLiveNamedFactory(networkName, undefined, process.env.ERC20_SPL_FACTORY_ADDRESS);
  const factory = await viem.getContractAt("ERC20SPLNamedFactory", factoryAddress);
  const publicClient = await viem.getPublicClient();
  await assertTestnetSend(publicClient, `${networkName} bootstrap-bridged-wrappers`);
  const set = resolveSet(networkName);

  console.log(`[${networkName}] deployer: ${deployer.account.address}`);
  console.log(`[${networkName}] factory:  ${factoryAddress} (named, live)`);
  const setLabel = set === TROME_SET ? "trome (devnet)" : set === HADRIAN_RESTORE_SET ? "hadrian-restore (devnet)" : set === COLLATERAL_SET_DEVNET ? "collateral (devnet)" : set === DEVNET_SET ? "devnet" : "mainnet";
  console.log(`[${networkName}] mint set: ${setLabel} (${set.length} entries)\n`);

  const deploymentsPath = `deployments/${networkName}.json`;
  const deployments = loadJson(deploymentsPath);

  for (const { slot, mintBase58 } of set) {
    const mint = base58ToBytes32(mintBase58);
    const existing = (await factory.read.token_by_mint([mint])) as `0x${string}`;
    // What the named factory would name it, from the same function the add runs; a revert is the add's refusal.
    const preview = await previewOutcome(() => factory.read.preview([mint]));
    const action = planEntry(existing, preview);

    if (action.kind === "existing") {
      console.log(`  ${mintBase58}: already registered → ${action.wrapper}`);
      const w = await viem.getContractAt("SPL_ERC20_cached", action.wrapper);
      deployments[recordKey(deployments, slot, action.wrapper)] = { address: action.wrapper, mintId: mintBase58, name: await w.read.name(), symbol: await w.read.symbol() };
      continue;
    }
    if (action.kind === "skip") {
      console.log(`  ${mintBase58}: SKIPPED. ${action.reason}`);
      continue;
    }

    console.log(`  ${mintBase58}: registering as "${action.name}" · ${action.symbol} ...`);
    const txHash = await factory.write.add_spl_token_with_metadata([mint]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    const wrapperAddress = (await factory.read.token_by_mint([mint])) as `0x${string}`;
    if (wrapperAddress.toLowerCase() === ZERO_ADDRESS) {
      throw new Error(`add_spl_token_with_metadata for ${mintBase58} landed but token_by_mint is still zero`);
    }
    console.log(`           tx: ${txHash}`);
    console.log(`           wrapper: ${wrapperAddress}`);

    deployments[recordKey(deployments, slot, wrapperAddress)] = {
      address: wrapperAddress,
      mintId: mintBase58,
      name: action.name,
      symbol: action.symbol,
      deployedAt: Math.floor(Date.now() / 1000),
      deployTx: txHash,
      via: "ERC20SPLNamedFactory.add_spl_token_with_metadata",
    };
    saveJson(deploymentsPath, deployments); // keep each wrapper's tx hash if a later one fails
  }

  saveJson(deploymentsPath, deployments);
  console.log(`\nSaved → ${deploymentsPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
