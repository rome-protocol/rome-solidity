import hardhat from "hardhat";
import { parseAbi } from "viem";
import bs58 from "bs58";

const OUTER = "0x4B7EB70311fD0752d270Ca1017CC49845c305321";
const outerAbi = parseAbi([
    "function internal_pool() view returns (address)",
]);
const innerAbi = parseAbi([
    "function pool_address() view returns (bytes32)",
    "function token_a_mint() view returns (bytes32)",
    "function token_b_mint() view returns (bytes32)",
    "function lp_mint() view returns (bytes32)",
    "function a_vault() view returns (bytes32)",
    "function b_vault() view returns (bytes32)",
    "function a_vault_lp() view returns (bytes32)",
    "function b_vault_lp() view returns (bytes32)",
    "function protocol_token_a_fee() view returns (bytes32)",
    "function protocol_token_b_fee() view returns (bytes32)",
    "function vault_a() view returns (uint8 enabled, uint8 vault_bump, uint8 token_vault_bump, uint64 total_amount, bytes32 token_vault, bytes32 fee_vault, bytes32 token_mint, bytes32 lp_mint, uint64 last_updated_locked_profit, uint64 last_report, uint64 locked_profit_degradation)",
    "function vault_b() view returns (uint8 enabled, uint8 vault_bump, uint8 token_vault_bump, uint64 total_amount, bytes32 token_vault, bytes32 fee_vault, bytes32 token_mint, bytes32 lp_mint, uint64 last_updated_locked_profit, uint64 last_report, uint64 locked_profit_degradation)",
]);

function b58(hex: string): string {
    return bs58.encode(Buffer.from(hex.slice(2), 'hex'));
}

async function main() {
    const { viem } = await hardhat.network.connect() as any;
    const pc = await viem.getPublicClient();
    const inner = await pc.readContract({ address: OUTER, abi: outerAbi, functionName: "internal_pool" }) as `0x${string}`;
    console.log(`internal_pool: ${inner}\n`);
    const fields = ["pool_address","token_a_mint","token_b_mint","lp_mint","a_vault","b_vault","a_vault_lp","b_vault_lp","protocol_token_a_fee","protocol_token_b_fee"];
    for (const f of fields) {
        try {
            const v = await pc.readContract({ address: inner, abi: innerAbi, functionName: f as any }) as `0x${string}`;
            const enc = b58(v);
            const mark = enc === "BctLf2Q2KxwYHwDd584NxUzECjgoHeTfQX2LqCBcGjdm" ? " <-- BctLf2Q!" : "";
            console.log(`  ${f.padEnd(24)} ${enc}${mark}`);
        } catch (e: any) { console.log(`  ${f.padEnd(24)} REVERT  (${e.shortMessage || e.message})`); }
    }
    console.log("\n--- vault_a ---");
    try {
        const va = await pc.readContract({ address: inner, abi: innerAbi, functionName: "vault_a" }) as any;
        console.log(`  token_vault: ${b58(va[4])}`);
        console.log(`  fee_vault:   ${b58(va[5])}`);
        console.log(`  token_mint:  ${b58(va[6])}`);
        console.log(`  lp_mint:     ${b58(va[7])}`);
    } catch (e: any) { console.log(`  REVERT: ${e.shortMessage}`); }
    console.log("\n--- vault_b ---");
    try {
        const vb = await pc.readContract({ address: inner, abi: innerAbi, functionName: "vault_b" }) as any;
        console.log(`  token_vault: ${b58(vb[4])}`);
        console.log(`  fee_vault:   ${b58(vb[5])}`);
        console.log(`  token_mint:  ${b58(vb[6])}`);
        console.log(`  lp_mint:     ${b58(vb[7])}`);
    } catch (e: any) { console.log(`  REVERT: ${e.shortMessage}`); }
}
main().catch(e => { console.error(e); process.exit(1); });
