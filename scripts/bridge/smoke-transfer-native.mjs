// Funded smoke: RomeBridgeWithdraw.transferNativeToWormhole (v11+).
//
// Proves the Wormhole transfer_native CPI end-to-end for a Solana-native mint
// (default wSOL). Two txs (the ~1.4M-CU split): approveWormholeBurn (delegate
// authority_signer) then transferNativeToWormhole. Tx success == the inner
// transfer_native + post_message CPIs succeeded on-chain (Rome atomic DoTx).
//
// Proven on Hadrian 2026-07-06 (v11 0x65fc94ba, 0.001 wSOL):
//   tx 0x4d112a2c7382b637f1e1964619b4a70e27a2fd38ebb3d4a18514be2b63fcff25
//
// Run:  KEYFILE=~/rome/.secrets/e2e/treasury-evm.key \
//         node scripts/bridge/smoke-transfer-native.mjs
//
// Preflight only (no funds spent — resolves addresses, checks allowlist +
// balance, then exits):  SMOKE_DRY_RUN=1 KEYFILE=... node scripts/bridge/smoke-transfer-native.mjs
//
// Config (env, all optional except KEYFILE):
//   NETWORK       deployments/<NETWORK>.json to read RomeBridgeWithdraw from (default hadrian)
//   RPC_URL       Rome RPC (default https://hadrian.testnet.romeprotocol.xyz/)
//   CHAIN_ID      Rome EVM chain id (default 200010)
//   WRAPPER       SPL_ERC20 wrapper over a Solana-NATIVE mint (default Hadrian canonical wSOL)
//   AMOUNT        base units (default 1000000 = 0.001 wSOL @ 9dp) — keep it dust
//   TARGET_CHAIN  Wormhole chain id (default 10002 Sepolia; must be allowlisted)
//   RECIPIENT32   32-byte hex recipient (default: sender, left-padded — redeemable, nothing strands)
//
// The withdraw address comes from deployments/<NETWORK>.json (the deploy
// receipt this repo commits) so the smoke always targets the LIVE contract —
// never a hardcoded address that goes stale on the next redeploy.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWalletClient, createPublicClient, http, defineChain, parseAbi, decodeEventLog, formatUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const NETWORK = process.env.NETWORK ?? "hadrian";
const RPC = process.env.RPC_URL ?? "https://hadrian.testnet.romeprotocol.xyz/";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 200010);
const WRAPPER = (process.env.WRAPPER ?? "0x1dece035621c65a90349b56a801068b439fa4201");
const AMOUNT = BigInt(process.env.AMOUNT ?? "1000000");
const TARGET_CHAIN = Number(process.env.TARGET_CHAIN ?? 10002);
const DRY_RUN = process.env.SMOKE_DRY_RUN === "1";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const deployments = JSON.parse(readFileSync(join(repoRoot, "deployments", `${NETWORK}.json`), "utf8"));
const WITHDRAW = deployments?.RomeBridgeWithdraw?.address;
if (!WITHDRAW) throw new Error(`no RomeBridgeWithdraw in deployments/${NETWORK}.json — deploy it first`);

let key = readFileSync(process.env.KEYFILE, "utf8").trim();
if (!key.startsWith("0x")) key = "0x" + key;
const account = privateKeyToAccount(key);

const chain = defineChain({
  id: CHAIN_ID, name: NETWORK,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

const abi = parseAbi([
  "function approveWormholeBurn(address assetWrapper, uint256 amount)",
  "function transferNativeToWormhole(address assetWrapper, uint256 amount, bytes32 recipient, uint16 targetChain)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function wormholeAssetAllowed(address) view returns (bool)",
  "function wormholeTargetChainAllowed(uint16) view returns (bool)",
  "event WormholeNativeTransfer(address indexed user, address indexed assetWrapper, bytes32 mint, uint256 amount, bytes32 recipient, uint16 targetChain)",
]);

const recipient32 = (process.env.RECIPIENT32 ?? ("0x" + "00".repeat(12) + account.address.slice(2))).toLowerCase();

const decimals = await pub.readContract({ address: WRAPPER, abi, functionName: "decimals" });
console.log(`network      ${NETWORK} (${CHAIN_ID}) via ${RPC}`);
console.log(`sender       ${account.address}`);
console.log(`withdraw     ${WITHDRAW} (deployments/${NETWORK}.json)`);
console.log(`wrapper      ${WRAPPER}`);
console.log(`amount       ${AMOUNT} (${formatUnits(AMOUNT, decimals)} @ ${decimals}dp)`);
console.log(`recipient32  ${recipient32} -> Wormhole chain ${TARGET_CHAIN}`);

// Preflight — every guard the contract checks before the CPI, read-only.
const [assetAllowed, chainAllowed, bal] = await Promise.all([
  pub.readContract({ address: WITHDRAW, abi, functionName: "wormholeAssetAllowed", args: [WRAPPER] }),
  pub.readContract({ address: WITHDRAW, abi, functionName: "wormholeTargetChainAllowed", args: [TARGET_CHAIN] }),
  pub.readContract({ address: WRAPPER, abi, functionName: "balanceOf", args: [account.address] }),
]);
console.log(`preflight    assetAllowed=${assetAllowed} chainAllowed=${chainAllowed} balance=${bal}`);
if (!assetAllowed) throw new Error(`wrapper ${WRAPPER} not allowlisted on ${WITHDRAW} (bridge-allowlist.yml)`);
if (!chainAllowed) throw new Error(`Wormhole chain ${TARGET_CHAIN} not allowlisted on ${WITHDRAW}`);
if (bal < AMOUNT) throw new Error(`insufficient balance: ${bal} < ${AMOUNT}`);

if (DRY_RUN) {
  console.log("\n✅ DRY RUN OK — all preflight checks pass; rerun without SMOKE_DRY_RUN to send.");
  process.exit(0);
}

const gasPrice = await pub.getGasPrice();

// tx1 — approve authority_signer as delegate on the sender's wrapper ATA.
console.log("\n[tx1] approveWormholeBurn …");
const h1 = await wallet.writeContract({
  address: WITHDRAW, abi, functionName: "approveWormholeBurn", args: [WRAPPER, AMOUNT],
  gas: 30_000_000n, gasPrice,
});
console.log(`      ${h1}`);
const r1 = await pub.waitForTransactionReceipt({ hash: h1 });
console.log(`      status=${r1.status} gasUsed=${r1.gasUsed}`);
if (r1.status !== "success") throw new Error("approveWormholeBurn reverted");

// tx2 — transfer_native CPI to Wormhole (lock in per-mint custody + post VAA).
console.log("\n[tx2] transferNativeToWormhole …");
const h2 = await wallet.writeContract({
  address: WITHDRAW, abi, functionName: "transferNativeToWormhole",
  args: [WRAPPER, AMOUNT, recipient32, TARGET_CHAIN],
  gas: 60_000_000n, gasPrice,
});
console.log(`      ${h2}`);
const r2 = await pub.waitForTransactionReceipt({ hash: h2 });
console.log(`      status=${r2.status} gasUsed=${r2.gasUsed}`);
if (r2.status !== "success") throw new Error("transferNativeToWormhole reverted");

let sawEvent = false;
for (const log of r2.logs) {
  try {
    const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
    if (ev.eventName === "WormholeNativeTransfer") {
      sawEvent = true;
      console.log(`\nWormholeNativeTransfer: ${JSON.stringify(ev.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    }
  } catch { /* non-matching log */ }
}

const balAfter = await pub.readContract({ address: WRAPPER, abi, functionName: "balanceOf", args: [account.address] });
console.log(`\nbalance: ${bal} -> ${balAfter}  (delta ${bal - balAfter})`);
console.log(sawEvent && r2.status === "success"
  ? "\n✅ SMOKE PASS — transfer_native CPI succeeded, VAA posted, WormholeNativeTransfer emitted."
  : "\n⚠️  tx succeeded but WormholeNativeTransfer not found — inspect logs.");
