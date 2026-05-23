import hardhat from "hardhat";
import { parseAbi } from "viem";
import bs58 from "bs58";

const POOL_WRAPPER = "0x4B7EB70311fD0752d270Ca1017CC49845c305321";

const abi = parseAbi([
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
    "function prog_dynamic_amm() view returns (bytes32)",
    "function prog_dynamic_vault() view returns (bytes32)",
]);

function b32_to_b58(hex: string): string {
    const bytes = Buffer.from(hex.slice(2), 'hex');
    return bs58.encode(bytes);
}

async function main() {
    const { viem } = await hardhat.network.connect() as any;
    const pc = await viem.getPublicClient();
    const fields = ["pool_address","token_a_mint","token_b_mint","lp_mint","a_vault","b_vault","a_vault_lp","b_vault_lp","protocol_token_a_fee","protocol_token_b_fee","prog_dynamic_amm","prog_dynamic_vault"];
    for (const f of fields) {
        try {
            const v = await pc.readContract({ address: POOL_WRAPPER, abi, functionName: f as any }) as `0x${string}`;
            const b58 = b32_to_b58(v);
            const mark = b58 === "BctLf2Q2KxwYHwDd584NxUzECjgoHeTfQX2LqCBcGjdm" ? " <-- BctLf2Q!" : "";
            console.log(`  ${f.padEnd(24)} ${b58}${mark}`);
        } catch (e: any) {
            console.log(`  ${f.padEnd(24)} REVERT`);
        }
    }
}
main().catch(e => { console.error(e); process.exit(1); });
