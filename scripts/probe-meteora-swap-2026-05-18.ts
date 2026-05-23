// One-shot probe: register Meteora USDC×SOL pool with the NEW factory
// (deployed by contract-deploys run 26014212331 — pending registry bump),
// deploy router, and run wUSDC → wSOL atomic swap. Captures Solana CU.
import hardhat from "hardhat";
import { getAddress, parseAbi } from "viem";
import { base58ToBytes32Hex } from "./lib/helpers.js";

const SOLANA_RPC = "https://node1.devnet-eu-sol-api.devnet.romeprotocol.xyz";

// NEW deploy from contract-deploys run 26014212331 (2026-05-18 05:15 UTC)
const FACTORY = "0xa3a4a27567f12133f3fe90c11403518c922de185" as const;
const TF      = "0x3c971eA1C7Cf7a1b0A8Af46f8A9e0648a82F9869" as const;
const CPI     = "0xFF00000000000000000000000000000000000008" as const;
const POOL_BASE58 = "VJwzHDDkunWrRS3mDsRd2JRWTt22G5PdRLZjQhWsJga";
const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SOL_MINT  = "So11111111111111111111111111111111111111112";

async function getSolanaTx(sig: string): Promise<any> {
  const res = await fetch(SOLANA_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "getTransaction",
      params: [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
    }),
  });
  return await res.json();
}

async function main() {
  const { viem } = await hardhat.network.connect() as any;
  const [deployer] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const me = deployer.account.address as `0x${string}`;
  console.log(`User: ${me}\n`);

  // ─── Register the pool with the new factory ───────────────────────────
  const factoryAbi = parseAbi([
    "function allPoolsLength() view returns (uint256)",
    "function getPool(address,address) view returns (address)",
    "function addPool(bytes32) returns (address)",
    "function token_factory() view returns (address)",
  ]);
  const tfAbi = parseAbi([
    "function token_by_mint(bytes32) view returns (address)",
  ]);
  const erc20Abi = parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
  ]);

  const poolPubkey = base58ToBytes32Hex(POOL_BASE58, "POOL") as `0x${string}`;
  const usdcMint = base58ToBytes32Hex(USDC_MINT, "USDC_MINT") as `0x${string}`;
  const solMint  = base58ToBytes32Hex(SOL_MINT, "SOL_MINT") as `0x${string}`;

  const wUsdc = getAddress(await pc.readContract({ address: TF, abi: tfAbi, functionName: "token_by_mint", args: [usdcMint] }) as `0x${string}`);
  const wSol  = getAddress(await pc.readContract({ address: TF, abi: tfAbi, functionName: "token_by_mint", args: [solMint] }) as `0x${string}`);
  console.log(`wUSDC (new TF): ${wUsdc}`);
  console.log(`wSOL  (new TF): ${wSol}\n`);

  const existing = getAddress(await pc.readContract({ address: FACTORY, abi: factoryAbi, functionName: "getPool", args: [wUsdc, wSol] }) as `0x${string}`);
  console.log(`existing pool wrapper: ${existing}`);

  if (existing === "0x0000000000000000000000000000000000000000") {
    console.log(`\nRegistering pool ${POOL_BASE58} in factory ${FACTORY}...`);
    const factory = await viem.getContractAt("MeteoraDAMMv1Factory", FACTORY);
    const txHash = await factory.write.addPool([poolPubkey], { account: deployer.account });
    console.log(`  tx: ${txHash}`);
    const rc = await pc.waitForTransactionReceipt({ hash: txHash });
    console.log(`  status: ${rc.status}, block: ${rc.blockNumber}`);

    const sigs: string[] = await pc.request({ method: "rome_solanaTxForEvmTx" as any, params: [txHash] }) as any ?? [];
    let cu = 0;
    for (const sig of sigs) {
      const st = await getSolanaTx(sig);
      cu += st?.result?.meta?.computeUnitsConsumed ?? 0;
    }
    console.log(`  Solana CU: ${cu}`);
  }
  const poolWrapper = getAddress(await pc.readContract({ address: FACTORY, abi: factoryAbi, functionName: "getPool", args: [wUsdc, wSol] }) as `0x${string}`);
  console.log(`\nPool wrapper: ${poolWrapper}`);

  // ─── Deploy router pointed at NEW factory ─────────────────────────────
  console.log(`\nDeploying MeteoraDAMMv1Router pointed at new factory...`);
  const router = await viem.deployContract("MeteoraDAMMv1Router", [FACTORY, CPI] as const);
  const routerAddr = getAddress(router.address);
  console.log(`router: ${routerAddr}`);

  // ─── Approve + swap ───────────────────────────────────────────────────
  const swapAmount = 10_000n; // 0.01 wUSDC
  const usdc = await viem.getContractAt("SPL_ERC20", wUsdc);

  const aPre = await pc.readContract({ address: wUsdc, abi: erc20Abi, functionName: "balanceOf", args: [me] }) as bigint;
  const bPre = await pc.readContract({ address: wSol,  abi: erc20Abi, functionName: "balanceOf", args: [me] }) as bigint;
  console.log(`\nPre-swap:  wUSDC=${aPre}  wSOL=${bPre}`);

  const allowance = await pc.readContract({ address: wUsdc, abi: erc20Abi, functionName: "allowance", args: [me, routerAddr] }) as bigint;
  if (allowance < swapAmount) {
    console.log(`Approving router for max wUSDC...`);
    const approveTx = await usdc.write.approve([routerAddr, (1n << 256n) - 1n], { account: deployer.account });
    await pc.waitForTransactionReceipt({ hash: approveTx });
  }

  const routerWrite = await viem.getContractAt("MeteoraDAMMv1Router", routerAddr);
  console.log(`\nSwap: ${swapAmount} wUSDC → wSOL (minOut=1)...`);
  try {
    const txHash = await routerWrite.write.swapExactTokensForTokens([wUsdc, wSol, swapAmount, 1n], { account: deployer.account });
    console.log(`  tx: ${txHash}`);
    const rc = await pc.waitForTransactionReceipt({ hash: txHash });
    console.log(`  status: ${rc.status}`);
    const sigs: string[] = await pc.request({ method: "rome_solanaTxForEvmTx" as any, params: [txHash] }) as any ?? [];
    let cu = 0;
    for (const sig of sigs) {
      const st = await getSolanaTx(sig);
      const c = st?.result?.meta?.computeUnitsConsumed ?? 0;
      console.log(`    sig=${sig.slice(0,16)}… CU=${c}`);
      cu += c;
    }
    console.log(`  TOTAL Solana CU: ${cu}`);
    if (cu > 0) console.log(`  Margin vs 1.4M: ${((1_400_000 - cu) / 1_400_000 * 100).toFixed(1)}%`);

    const aPost = await pc.readContract({ address: wUsdc, abi: erc20Abi, functionName: "balanceOf", args: [me] }) as bigint;
    const bPost = await pc.readContract({ address: wSol,  abi: erc20Abi, functionName: "balanceOf", args: [me] }) as bigint;
    console.log(`\nPost-swap: wUSDC=${aPost} (Δ ${aPost - aPre})  wSOL=${bPost} (Δ ${bPost - bPre})`);
    console.log(`\n=== VERDICT ===`);
    console.log(`Atomic w → w via Meteora CPI: ${(aPre - aPost === swapAmount && bPost > bPre) ? "✓ WORKS" : "✗ INCOMPLETE"}`);
  } catch (e: any) {
    console.log(`  ✗ Swap failed: ${e.shortMessage ?? e.message ?? e}`);
    if (e.metaMessages) console.log(`  meta: ${e.metaMessages.join(" / ")}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
