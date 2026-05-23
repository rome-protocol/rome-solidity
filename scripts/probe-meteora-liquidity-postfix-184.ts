// Liquidity smoke probe — addLiquidity + removeLiquidity through the new
// Meteora factory (#184 trailing-meta fix). Exercises build_balance_liquidity_account_metas
// (the 16-meta variant, post-fix; was 17-meta pre-fix).
//
// Setup: user already has wUSDC + wSOL post-swap. Add small liquidity, capture
// CU, then remove all LP tokens.

import hardhat from "hardhat";
import { parseAbi, getAddress } from "viem";

const SOLANA_RPC = "https://node1.devnet-eu-sol-api.devnet.romeprotocol.xyz";
const FACTORY = "0x6ce0e90db2b54b9a433530cd5b3d31573a401c3e" as const;
const POOL_OUTER = "0x8f104482e81A9A56C3e6F37C76f9a4878f96aEB8" as const;
const WUSDC = "0x9fD4D58dbB041CaFF77d323d2410c16DE339eB18" as const;
const WSOL  = "0x28E7c064E734cB3edeA65A98927c1c20581c8934" as const;

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
    const [d] = await viem.getWalletClients();
    const pc = await viem.getPublicClient();
    const me = d.account.address as `0x${string}`;
    console.log(`User: ${me}\nPool wrapper: ${POOL_OUTER}\n`);

    const erc20Abi = parseAbi([
        "function balanceOf(address) view returns (uint256)",
        "function approve(address,uint256) returns (bool)",
        "function decimals() view returns (uint8)",
        "function symbol() view returns (string)",
    ]);

    const wusdcBal = await pc.readContract({ address: WUSDC, abi: erc20Abi, functionName: "balanceOf", args: [me] }) as bigint;
    const wsolBal  = await pc.readContract({ address: WSOL,  abi: erc20Abi, functionName: "balanceOf", args: [me] }) as bigint;
    console.log(`Pre-balances: wUSDC=${wusdcBal}  wSOL=${wsolBal}\n`);

    // Read LP mint + the user's LP balance via pool wrapper
    const poolAbi = parseAbi([
        "function prepareAddLiquidity(address user, uint256 max_a, uint256 max_b, uint256 slippage_rate) view returns (uint64 pool_token_amount, (bytes32 pool, bytes32 lp_mint, bytes32 user_pool_lp, bytes32 a_vault_lp, bytes32 b_vault_lp, bytes32 a_vault, bytes32 b_vault, bytes32 a_vault_lp_mint, bytes32 b_vault_lp_mint, bytes32 a_token_vault, bytes32 b_token_vault, bytes32 user_a_token, bytes32 user_b_token, bytes32 user, bytes32 vault_program, bytes32 token_program) liquidity_accounts)",
        "function addLiquidity(uint256 pool_token_amount, uint256 max_token_a_amount, uint256 max_token_b_amount, (bytes32 user_pool_lp, bytes32 user_a_token, bytes32 user_b_token) user_accounts) external",
        "function removeLiquidity(uint256 pool_token_amount, uint256 min_a_out, uint256 min_b_out) external",
        "function ensurePoolLpTokenAccount() external returns (bytes32)",
    ]);

    // ──── Step 1: ensure user's LP token account exists ────
    console.log(`\n--- ensurePoolLpTokenAccount ---`);
    const ep = await viem.getContractAt("ERC20DAMMv1Pool", POOL_OUTER);
    try {
        const tx = await ep.write.ensurePoolLpTokenAccount({ account: d.account, gas: 30_000_000n });
        const rc = await pc.waitForTransactionReceipt({ hash: tx });
        console.log(`  status=${rc.status} gas=${rc.gasUsed}`);
        await captureCu(pc, tx);
    } catch (e: any) {
        console.log(`  (may have failed, ok if LP account already exists): ${e.shortMessage || e.message}`);
    }

    // ──── Step 2: addLiquidity ────
    // Add at most 5000 wUSDC + 2x its equivalent in wSOL (rough)
    // Provide all available wSOL + a balanced wUSDC slice (pool ratio ~10.2 USDC/SOL).
    // slippage_rate is PERCENT (0..100), not bps — `* (100 - slippage) / 100`.
    const max_b = wsolBal;
    const max_a = (wsolBal * 11n) / 1000n; // ~11 wUSDC per 1k wSOL = ~10.5 USDC/SOL with headroom
    console.log(`\n--- prepareAddLiquidity(max_a=${max_a}, max_b=${max_b}, slippage=1%) ---`);
    const prep = await pc.readContract({
        address: POOL_OUTER, abi: poolAbi, functionName: "prepareAddLiquidity",
        args: [me, max_a, max_b, 1n],
    }) as any;
    const pool_token_amount = prep[0];
    const liq_accts = prep[1];
    console.log(`  pool_token_amount: ${pool_token_amount}`);
    const user_accts = {
        user_pool_lp: liq_accts.user_pool_lp,
        user_a_token: liq_accts.user_a_token,
        user_b_token: liq_accts.user_b_token,
    };

    console.log(`\n--- addLiquidity ---`);
    try {
        const tx = await ep.write.addLiquidity([pool_token_amount, max_a, max_b, user_accts], { account: d.account, gas: 30_000_000n });
        const rc = await pc.waitForTransactionReceipt({ hash: tx });
        console.log(`  tx: ${tx}\n  status=${rc.status} gas=${rc.gasUsed}`);
        const cu = await captureCu(pc, tx);
        console.log(`  TOTAL Solana CU: ${cu}  (margin vs 1.4M: ${((1_400_000 - cu) / 1_400_000 * 100).toFixed(1)}%)`);
    } catch (e: any) {
        console.log(`  REVERTED: ${e.shortMessage || e.message}`);
    }

    const aPostAdd = await pc.readContract({ address: WUSDC, abi: erc20Abi, functionName: "balanceOf", args: [me] }) as bigint;
    const bPostAdd = await pc.readContract({ address: WSOL,  abi: erc20Abi, functionName: "balanceOf", args: [me] }) as bigint;
    console.log(`Post-add: wUSDC=${aPostAdd} (Δ${aPostAdd - wusdcBal})  wSOL=${bPostAdd} (Δ${bPostAdd - wsolBal})`);

    // ──── Step 3: removeLiquidity — burn ALL our LP tokens ────
    // We don't have a direct LP balance read, so just attempt with the pool_token_amount we just added
    console.log(`\n--- removeLiquidity (${pool_token_amount} LP) ---`);
    try {
        const tx = await ep.write.removeLiquidity([pool_token_amount, 1n, 1n], { account: d.account, gas: 30_000_000n });
        const rc = await pc.waitForTransactionReceipt({ hash: tx });
        console.log(`  tx: ${tx}\n  status=${rc.status} gas=${rc.gasUsed}`);
        const cu = await captureCu(pc, tx);
        console.log(`  TOTAL Solana CU: ${cu}  (margin vs 1.4M: ${((1_400_000 - cu) / 1_400_000 * 100).toFixed(1)}%)`);
    } catch (e: any) {
        console.log(`  REVERTED: ${e.shortMessage || e.message}`);
    }

    const aPostRem = await pc.readContract({ address: WUSDC, abi: erc20Abi, functionName: "balanceOf", args: [me] }) as bigint;
    const bPostRem = await pc.readContract({ address: WSOL,  abi: erc20Abi, functionName: "balanceOf", args: [me] }) as bigint;
    console.log(`Post-remove: wUSDC=${aPostRem} (Δ${aPostRem - aPostAdd})  wSOL=${bPostRem} (Δ${bPostRem - bPostAdd})`);

    console.log(`\n=== VERDICT ===`);
    console.log(`  addLiquidity exercises build_balance_liquidity_account_metas:    ${aPostAdd < wusdcBal ? '✓ ran' : '✗ did not run'}`);
    console.log(`  removeLiquidity exercises build_balance_liquidity_account_metas: ${aPostRem > aPostAdd ? '✓ ran' : '✗ did not run'}`);
}
main().catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
