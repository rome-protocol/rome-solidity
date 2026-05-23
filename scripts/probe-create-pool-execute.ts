// EXECUTE createPermissionlessConstantProductPoolWithConfig2.
// Uses config index 0 + USDC + SOL → derives a new pool key (different from
// VJwzHDDk which uses a different config).
import hardhat from "hardhat";
import { parseAbi } from "viem";
import bs58 from "bs58";

const FACTORY = "0x6ce0e90db2b54b9a433530cd5b3d31573a401c3e";
const USDC_MINT_B58 = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SOL_MINT_B58  = "So11111111111111111111111111111111111111112";
const WUSDC = "0x9fD4D58dbB041CaFF77d323d2410c16DE339eB18";
const WSOL  = "0x28E7c064E734cB3edeA65A98927c1c20581c8934";
const SOLANA_RPC = "https://node1.devnet-eu-sol-api.devnet.romeprotocol.xyz";

function b58_to_b32(s: string): `0x${string}` {
    return ("0x" + Buffer.from(bs58.decode(s)).toString("hex")) as `0x${string}`;
}
function b32_to_b58(h: string): string {
    return bs58.encode(Buffer.from(h.slice(2), "hex"));
}

async function getSolanaTx(sig: string): Promise<any> {
    const res = await fetch(SOLANA_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({jsonrpc:"2.0",id:1,method:"getTransaction",params:[sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]}),
    });
    return await res.json();
}
async function captureCu(pc: any, txHash: `0x${string}`): Promise<{sigs: number, total: number, max_one: number}> {
    const sigs: string[] = await pc.request({ method: "rome_solanaTxForEvmTx" as any, params: [txHash] }) as any ?? [];
    let total = 0, mx = 0;
    for (const sig of sigs) {
        const st = await getSolanaTx(sig);
        const cu = st?.result?.meta?.computeUnitsConsumed ?? 0;
        total += cu;
        if (cu > mx) mx = cu;
    }
    return {sigs: sigs.length, total, max_one: mx};
}

async function main() {
    const { viem } = await hardhat.network.connect() as any;
    const [d] = await viem.getWalletClients();
    const pc = await viem.getPublicClient();

    const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
    const wusdcBal = await pc.readContract({ address: WUSDC as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [d.account.address] }) as bigint;
    const wsolBal  = await pc.readContract({ address: WSOL  as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [d.account.address] }) as bigint;
    console.log(`User wUSDC=${wusdcBal}  wSOL=${wsolBal}\n`);

    // Seed amounts — tiny, just to bootstrap the new pool
    const a_amount = 100_000n;   // 0.1 wUSDC
    const b_amount = 50_000n;    // 0.00005 wSOL

    if (wusdcBal < a_amount || wsolBal < b_amount) {
        console.log(`INSUFFICIENT: need ${a_amount} wUSDC + ${b_amount} wSOL`);
        return;
    }

    const factoryAbi = parseAbi([
        "function deriveConfigKey(uint64 index) view returns (bytes32)",
        "function preparePermissionlessConstantProductPoolWithConfig2(bytes32 a, bytes32 b, bytes32 config) view returns ((bytes32 pool, bytes32 config, bytes32 lp_mint, bytes32 token_a_mint, bytes32 token_b_mint, bytes32 a_vault, bytes32 b_vault, bytes32 a_token_vault, bytes32 b_token_vault, bytes32 a_vault_lp_mint, bytes32 b_vault_lp_mint, bytes32 a_vault_lp, bytes32 b_vault_lp, bytes32 payer_token_a, bytes32 payer_token_b, bytes32 payer_pool_lp, bytes32 protocol_token_a_fee, bytes32 protocol_token_b_fee, bytes32 payer, bytes32 rent, bytes32 vault_program, bytes32 token_program, bytes32 associated_token_program, bytes32 system_program, bytes32 metadata_program, bytes32 mint_metadata))",
        "function createPermissionlessConstantProductPoolWithConfig2(uint64 token_a_amount, uint64 token_b_amount, (bytes32 pool, bytes32 config, bytes32 lp_mint, bytes32 token_a_mint, bytes32 token_b_mint, bytes32 a_vault, bytes32 b_vault, bytes32 a_token_vault, bytes32 b_token_vault, bytes32 a_vault_lp_mint, bytes32 b_vault_lp_mint, bytes32 a_vault_lp, bytes32 b_vault_lp, bytes32 payer_token_a, bytes32 payer_token_b, bytes32 payer_pool_lp, bytes32 protocol_token_a_fee, bytes32 protocol_token_b_fee, bytes32 payer, bytes32 rent, bytes32 vault_program, bytes32 token_program, bytes32 associated_token_program, bytes32 system_program, bytes32 metadata_program, bytes32 mint_metadata) accounts) returns (bytes32)",
        "function getPool(address,address) view returns (address)",
    ]);

    const cfg = await pc.readContract({ address: FACTORY as `0x${string}`, abi: factoryAbi, functionName: "deriveConfigKey", args: [0n] }) as `0x${string}`;
    console.log(`Config (index 0): ${b32_to_b58(cfg)}`);

    const accts = await pc.readContract({
        address: FACTORY as `0x${string}`, abi: factoryAbi,
        functionName: "preparePermissionlessConstantProductPoolWithConfig2",
        args: [b58_to_b32(USDC_MINT_B58), b58_to_b32(SOL_MINT_B58), cfg],
    }) as any;
    console.log(`Derived pool: ${b32_to_b58(accts.pool)}\n`);

    console.log("--- calling createPermissionlessConstantProductPoolWithConfig2 ---");
    const factoryC = await viem.getContractAt("MeteoraDAMMv1Factory", FACTORY);
    try {
        const tx = await factoryC.write.createPermissionlessConstantProductPoolWithConfig2([a_amount, b_amount, accts], {
            account: d.account, gas: 30_000_000n,
        });
        console.log(`  tx: ${tx}`);
        const rc = await pc.waitForTransactionReceipt({ hash: tx });
        console.log(`  status: ${rc.status}, evm gas: ${rc.gasUsed}`);
        const cu = await captureCu(pc, tx);
        console.log(`  sigs: ${cu.sigs}, total Solana CU: ${cu.total}, max single sig: ${cu.max_one}`);
        console.log(`  margin vs 1.4M atomic: ${((1_400_000 - cu.max_one) / 1_400_000 * 100).toFixed(1)}%`);

        // Did the new EVM-side wrapper get registered?
        const newWrapper = await pc.readContract({
            address: FACTORY as `0x${string}`, abi: factoryAbi,
            functionName: "getPool", args: [WUSDC, WSOL],
        }) as `0x${string}`;
        console.log(`\n  getPool(wUSDC, wSOL) after create: ${newWrapper}`);
        console.log(`  (existing pool wrapper was 0x8f104482e81A9A56C3e6F37C76f9a4878f96aEB8 for the OTHER config)`);
        
        console.log(`\n=== VERDICT ===`);
        console.log(`  Pool created on Solana:           ${rc.status === 'success' ? '✓' : '✗'}`);
        console.log(`  Total CU under atomic 1.4M cap:   ${cu.max_one < 1_400_000 ? '✓' : '✗'}`);
    } catch (e: any) {
        console.log(`  REVERTED: ${e.shortMessage || e.message}`);
    }
}
main().catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
