// End-to-end smoke for the Meteora w → w swap path on Hadrian, against the
// post-fix-179 factory deployed today by contract-deploys run 26020156799.
//
// Steps (all in one tx-flow):
//   1. Register live Solana Meteora USDC × SOL pool with the new factory
//   2. Deploy a fresh MeteoraDAMMv1Router pointed at the new factory
//   3. Approve router for wUSDC
//   4. Swap 0.01 wUSDC → wSOL via Meteora CPI
//   5. Capture Solana CU
//
// Hardcodes the new factory address since registry bump is pending PR-back
// merge — uses `deployments/hadrian.json` as a stale fallback for everything
// else.
import hardhat from "hardhat";
import { getAddress, parseAbi } from "viem";
import { base58ToBytes32Hex } from "./lib/helpers.js";

const SOLANA_RPC = "https://node1.devnet-eu-sol-api.devnet.romeprotocol.xyz";

// From contract-deploys run 26020156799 (2026-05-18 07:42 UTC) — first deploy
// with the parse_vault VAULT_MIN_LEN fix (PR #179, sha 2a54859).
const FACTORY = "0xd68b355f62643de0ec40243cba8f699f959ea3c4" as const;
const CPI = "0xFF00000000000000000000000000000000000008" as const;

// Live Meteora DAMM v1 pool on Solana devnet (per ops registry — the testnet
// shared USDC/SOL pool used for chain gas pricing).
const POOL_BASE58 = "VJwzHDDkunWrRS3mDsRd2JRWTt22G5PdRLZjQhWsJga";
const USDC_MINT_BASE58 = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SOL_MINT_BASE58 = "So11111111111111111111111111111111111111112";

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

async function captureCu(pc: any, txHash: `0x${string}`): Promise<number> {
    const sigs: string[] = await pc.request({ method: "rome_solanaTxForEvmTx" as any, params: [txHash] }) as any ?? [];
    let total = 0;
    for (const sig of sigs) {
        const st = await getSolanaTx(sig);
        const cu = st?.result?.meta?.computeUnitsConsumed ?? 0;
        console.log(`    sig=${sig.slice(0, 16)}…  CU=${cu}`);
        total += cu;
    }
    return total;
}

async function main() {
    const { viem } = await hardhat.network.connect() as any;
    const [deployer] = await viem.getWalletClients();
    const pc = await viem.getPublicClient();
    const me = deployer.account.address as `0x${string}`;
    console.log(`User: ${me}\n`);

    const poolPubkey = base58ToBytes32Hex(POOL_BASE58, "POOL") as `0x${string}`;
    const usdcMint = base58ToBytes32Hex(USDC_MINT_BASE58, "USDC") as `0x${string}`;
    const solMint = base58ToBytes32Hex(SOL_MINT_BASE58, "SOL") as `0x${string}`;

    // ─── Step 0: probe factory + token_factory state ───────────────────────
    const factoryAbi = parseAbi([
        "function token_factory() view returns (address)",
        "function getPool(address,address) view returns (address)",
        "function addPool(bytes32) returns (address)",
        "function allPoolsLength() view returns (uint256)",
    ]);
    const tfAbi = parseAbi(["function token_by_mint(bytes32) view returns (address)"]);
    const erc20Abi = parseAbi([
        "function balanceOf(address) view returns (uint256)",
        "function approve(address,uint256) returns (bool)",
        "function allowance(address,address) view returns (uint256)",
        "function symbol() view returns (string)",
        "function decimals() view returns (uint8)",
    ]);

    const tf = getAddress(await pc.readContract({ address: FACTORY, abi: factoryAbi, functionName: "token_factory" }) as `0x${string}`);
    console.log(`Factory:          ${FACTORY}`);
    console.log(`TokenFactory:     ${tf}`);
    const wUsdc = getAddress(await pc.readContract({ address: tf, abi: tfAbi, functionName: "token_by_mint", args: [usdcMint] }) as `0x${string}`);
    const wSol = getAddress(await pc.readContract({ address: tf, abi: tfAbi, functionName: "token_by_mint", args: [solMint] }) as `0x${string}`);
    console.log(`wUSDC:            ${wUsdc}`);
    console.log(`wSOL:             ${wSol}\n`);

    if (wUsdc === "0x0000000000000000000000000000000000000000" || wSol === "0x0000000000000000000000000000000000000000") {
        throw new Error("Wrappers not registered in the factory's token_factory — halt.");
    }

    // ─── Step 1: register pool ──────────────────────────────────────────────
    let poolWrapper = getAddress(await pc.readContract({ address: FACTORY, abi: factoryAbi, functionName: "getPool", args: [wUsdc, wSol] }) as `0x${string}`);
    if (poolWrapper === "0x0000000000000000000000000000000000000000") {
        console.log(`Registering Meteora pool ${POOL_BASE58} in factory...`);
        const f = await viem.getContractAt("MeteoraDAMMv1Factory", FACTORY);
        const txHash = await f.write.addPool([poolPubkey], { account: deployer.account });
        console.log(`  tx: ${txHash}`);
        const rc = await pc.waitForTransactionReceipt({ hash: txHash });
        console.log(`  status: ${rc.status}, evm gas: ${rc.gasUsed}`);
        const cu = await captureCu(pc, txHash);
        console.log(`  TOTAL Solana CU: ${cu}`);

        poolWrapper = getAddress(await pc.readContract({ address: FACTORY, abi: factoryAbi, functionName: "getPool", args: [wUsdc, wSol] }) as `0x${string}`);
        if (poolWrapper === "0x0000000000000000000000000000000000000000") {
            throw new Error("addPool succeeded but getPool returned zero — should not happen.");
        }
    } else {
        console.log(`Pool already registered at ${poolWrapper}`);
    }
    console.log(`\nPool wrapper:     ${poolWrapper}\n`);

    // ─── Step 2: deploy fresh router ───────────────────────────────────────
    console.log(`Deploying MeteoraDAMMv1Router pointed at new factory...`);
    const r = await viem.deployContract("MeteoraDAMMv1Router", [FACTORY, CPI] as const);
    const routerAddr = getAddress(r.address);
    console.log(`Router:           ${routerAddr}\n`);

    // ─── Step 3: approve router for wUSDC ──────────────────────────────────
    const swapAmount = 10_000n; // 0.01 wUSDC (6 decimals)
    const usdc = await viem.getContractAt("SPL_ERC20", wUsdc);
    const allowance = await pc.readContract({ address: wUsdc, abi: erc20Abi, functionName: "allowance", args: [me, routerAddr] }) as bigint;
    if (allowance < swapAmount) {
        console.log(`Approving router for wUSDC...`);
        const txApprove = await usdc.write.approve([routerAddr, (1n << 256n) - 1n], { account: deployer.account });
        await pc.waitForTransactionReceipt({ hash: txApprove });
        console.log(`  approve tx: ${txApprove}`);
    }

    // ─── Step 4: snapshot + swap ───────────────────────────────────────────
    const aPre = await pc.readContract({ address: wUsdc, abi: erc20Abi, functionName: "balanceOf", args: [me] }) as bigint;
    const bPre = await pc.readContract({ address: wSol, abi: erc20Abi, functionName: "balanceOf", args: [me] }) as bigint;
    console.log(`\nPre-swap:  wUSDC=${aPre}  wSOL=${bPre}`);

    const router = await viem.getContractAt("MeteoraDAMMv1Router", routerAddr);
    console.log(`\nSwap: ${swapAmount} wUSDC → wSOL (minOut=1)...`);
    try {
        const txHash = await router.write.swapExactTokensForTokens(
            [wUsdc, wSol, swapAmount, 1n],
            { account: deployer.account, gas: 30_000_000n },
        );
        console.log(`  tx: ${txHash}`);
        const rc = await pc.waitForTransactionReceipt({ hash: txHash });
        console.log(`  status: ${rc.status}, evm gas: ${rc.gasUsed}`);
        const cu = await captureCu(pc, txHash);
        console.log(`  TOTAL Solana CU: ${cu}`);
        if (cu > 0) console.log(`  Margin vs 1.4M: ${((1_400_000 - cu) / 1_400_000 * 100).toFixed(1)}%`);

        const aPost = await pc.readContract({ address: wUsdc, abi: erc20Abi, functionName: "balanceOf", args: [me] }) as bigint;
        const bPost = await pc.readContract({ address: wSol, abi: erc20Abi, functionName: "balanceOf", args: [me] }) as bigint;
        console.log(`\nPost-swap: wUSDC=${aPost} (Δ ${aPost - aPre})  wSOL=${bPost} (Δ ${bPost - bPre})`);

        const usdcOut = aPre - aPost === swapAmount;
        const solIn = bPost > bPre;
        console.log(`\n=== VERDICT ===`);
        console.log(`wUSDC debited:                    ${usdcOut ? "✓" : "✗"}`);
        console.log(`wSOL credited:                    ${solIn ? "✓" : "✗"}`);
        console.log(`Atomic w → w via Meteora CPI:     ${usdcOut && solIn ? "✓ WORKS" : "✗ INCOMPLETE"}`);
    } catch (e: any) {
        console.log(`\n✗ Swap failed: ${e.shortMessage ?? e.message ?? e}`);
        if (e.metaMessages) console.log(`  meta: ${e.metaMessages.join(" / ")}`);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
