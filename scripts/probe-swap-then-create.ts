// Pre-swap a small wUSDC → wSOL to get balance, then create new pool with config index 0.
import hardhat from "hardhat";
import { parseAbi } from "viem";
import bs58 from "bs58";

const FACTORY = "0x6ce0e90db2b54b9a433530cd5b3d31573a401c3e";
const POOL_OUTER = "0x8f104482e81A9A56C3e6F37C76f9a4878f96aEB8";
const USDC_B58 = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SOL_B58  = "So11111111111111111111111111111111111111112";
const WUSDC = "0x9fD4D58dbB041CaFF77d323d2410c16DE339eB18";
const WSOL  = "0x28E7c064E734cB3edeA65A98927c1c20581c8934";
const SOLANA_RPC = "https://node1.devnet-eu-sol-api.devnet.romeprotocol.xyz";

function b58_b32(s: string): `0x${string}` { return ("0x" + Buffer.from(bs58.decode(s)).toString("hex")) as `0x${string}`; }
function b32_b58(h: string): string { return bs58.encode(Buffer.from(h.slice(2), "hex")); }

async function solTx(sig: string) {
    const r = await fetch(SOLANA_RPC, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"getTransaction",params:[sig,{encoding:"json",commitment:"confirmed",maxSupportedTransactionVersion:0}]})});
    return await r.json();
}
async function cu(pc: any, h: `0x${string}`) {
    const sigs: string[] = await pc.request({method:"rome_solanaTxForEvmTx" as any, params:[h]}) as any ?? [];
    let total=0,mx=0;
    for (const s of sigs) {
        const t = await solTx(s);
        const c = t?.result?.meta?.computeUnitsConsumed ?? 0;
        total += c; if (c>mx) mx=c;
    }
    return {sigs:sigs.length, total, max:mx};
}

async function main() {
    const { viem } = await hardhat.network.connect() as any;
    const [d] = await viem.getWalletClients();
    const pc = await viem.getPublicClient();

    const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
    let wusdc = await pc.readContract({address: WUSDC as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [d.account.address]}) as bigint;
    let wsol  = await pc.readContract({address: WSOL  as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [d.account.address]}) as bigint;
    console.log(`pre: wUSDC=${wusdc} wSOL=${wsol}\n`);

    // Step 1: swap 50_000 wUSDC → wSOL on the existing pool
    console.log(`--- pre-swap 50000 wUSDC → wSOL (existing pool) ---`);
    const pool = await viem.getContractAt("ERC20DAMMv1Pool", POOL_OUTER);
    const stx = await pool.write.swapExactTokensForTokens([WUSDC, 50000n, 1n], {account: d.account, gas: 30_000_000n});
    const src = await pc.waitForTransactionReceipt({hash: stx});
    console.log(`  status=${src.status}`);
    wusdc = await pc.readContract({address: WUSDC as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [d.account.address]}) as bigint;
    wsol  = await pc.readContract({address: WSOL  as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [d.account.address]}) as bigint;
    console.log(`  post-swap: wUSDC=${wusdc} wSOL=${wsol}\n`);

    // Step 2: derive new pool accounts (config index 0)
    const factoryAbi = parseAbi([
        "function deriveConfigKey(uint64 index) view returns (bytes32)",
        "function preparePermissionlessConstantProductPoolWithConfig2(bytes32 a, bytes32 b, bytes32 config) view returns ((bytes32 pool, bytes32 config, bytes32 lp_mint, bytes32 token_a_mint, bytes32 token_b_mint, bytes32 a_vault, bytes32 b_vault, bytes32 a_token_vault, bytes32 b_token_vault, bytes32 a_vault_lp_mint, bytes32 b_vault_lp_mint, bytes32 a_vault_lp, bytes32 b_vault_lp, bytes32 payer_token_a, bytes32 payer_token_b, bytes32 payer_pool_lp, bytes32 protocol_token_a_fee, bytes32 protocol_token_b_fee, bytes32 payer, bytes32 rent, bytes32 vault_program, bytes32 token_program, bytes32 associated_token_program, bytes32 system_program, bytes32 metadata_program, bytes32 mint_metadata))",
        "function createPermissionlessConstantProductPoolWithConfig2(uint64 token_a_amount, uint64 token_b_amount, (bytes32 pool, bytes32 config, bytes32 lp_mint, bytes32 token_a_mint, bytes32 token_b_mint, bytes32 a_vault, bytes32 b_vault, bytes32 a_token_vault, bytes32 b_token_vault, bytes32 a_vault_lp_mint, bytes32 b_vault_lp_mint, bytes32 a_vault_lp, bytes32 b_vault_lp, bytes32 payer_token_a, bytes32 payer_token_b, bytes32 payer_pool_lp, bytes32 protocol_token_a_fee, bytes32 protocol_token_b_fee, bytes32 payer, bytes32 rent, bytes32 vault_program, bytes32 token_program, bytes32 associated_token_program, bytes32 system_program, bytes32 metadata_program, bytes32 mint_metadata) accounts) returns (bytes32)",
    ]);

    const cfg = await pc.readContract({address: FACTORY as `0x${string}`, abi: factoryAbi, functionName:"deriveConfigKey", args:[0n]}) as `0x${string}`;
    const accts = await pc.readContract({
        address: FACTORY as `0x${string}`, abi: factoryAbi,
        functionName: "preparePermissionlessConstantProductPoolWithConfig2",
        args: [b58_b32(USDC_B58), b58_b32(SOL_B58), cfg],
    }) as any;
    console.log(`new pool key (config 0): ${b32_b58(accts.pool)}`);

    // Step 3: actually create the pool — use whatever wSOL we got + matching wUSDC
    const a_amount = wusdc > 50000n ? 50000n : wusdc / 2n;
    const b_amount = wsol > 1000n ? wsol / 2n : wsol;
    console.log(`\n--- createPermissionlessConstantProductPoolWithConfig2(a=${a_amount}, b=${b_amount}) ---`);
    const fc = await viem.getContractAt("MeteoraDAMMv1Factory", FACTORY);
    try {
        const tx = await fc.write.createPermissionlessConstantProductPoolWithConfig2([a_amount, b_amount, accts], {
            account: d.account, gas: 30_000_000n,
        });
        console.log(`  tx: ${tx}`);
        const rc = await pc.waitForTransactionReceipt({hash: tx});
        console.log(`  status=${rc.status} gas=${rc.gasUsed}`);
        const c = await cu(pc, tx);
        console.log(`  sigs=${c.sigs} total CU=${c.total} max-single-sig CU=${c.max}`);
        console.log(`  margin vs 1.4M atomic (max sig): ${((1_400_000 - c.max) / 1_400_000 * 100).toFixed(1)}%`);
        console.log(`\n=== createPool VERDICT ===`);
        console.log(`  status: ${rc.status === 'success' ? '✓ SUCCESS' : '✗ FAILED'}`);
    } catch (e: any) {
        console.log(`  REVERTED: ${e.shortMessage || e.message}`);
    }
}
main().catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
