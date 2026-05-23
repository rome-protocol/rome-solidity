import hardhat from "hardhat";
import { parseAbi } from "viem";
import bs58 from "bs58";

const OUTER = "0x4B7EB70311fD0752d270Ca1017CC49845c305321";
const USER = "0x1f4946be340f06c46a50e65084790968abcc48f6";
const outerAbi = parseAbi(["function internal_pool() view returns (address)"]);
const innerAbi = parseAbi([
    "function make_swap_accounts_from_pool(address user_addr, uint8 in_token) view returns (bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32)",
]);

const labels = ["pool","user_source_token","user_destination_token","a_vault_lp","b_vault_lp","a_vault","b_vault","a_vault_lp_mint","b_vault_lp_mint","a_token_vault","b_token_vault","user","vault_program","token_program","protocol_token_fee"];

function b58(hex: string): string { return bs58.encode(Buffer.from(hex.slice(2), 'hex')); }

async function main() {
    const { viem } = await hardhat.network.connect() as any;
    const pc = await viem.getPublicClient();
    const inner = await pc.readContract({ address: OUTER, abi: outerAbi, functionName: "internal_pool" }) as `0x${string}`;
    console.log(`inner pool: ${inner}\n`);
    try {
        const result = await pc.readContract({ address: inner, abi: innerAbi, functionName: "make_swap_accounts_from_pool", args: [USER, 0] }) as any;
        console.log("metas (wUSDC → wSOL):");
        for (let i = 0; i < 15; i++) {
            const enc = b58(result[i]);
            const mark = enc === "BctLf2Q2KxwYHwDd584NxUzECjgoHeTfQX2LqCBcGjdm" ? " <-- BctLf2Q!" : "";
            console.log(`  metas[${i.toString().padStart(2)}]  ${labels[i].padEnd(22)} ${enc}${mark}`);
        }
    } catch (e: any) {
        console.log(`REVERT: ${e.shortMessage || e.message}`);
    }
}
main().catch(e => { console.error(e.shortMessage || e); process.exit(1); });
