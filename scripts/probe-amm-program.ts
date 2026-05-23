import hardhat from "hardhat";
import { parseAbi } from "viem";
import bs58 from "bs58";

const OUTER = "0x4B7EB70311fD0752d270Ca1017CC49845c305321";
const outerAbi = parseAbi([
    "function internal_pool() view returns (address)"
]);
const innerAbi = parseAbi([
    "function prog_dynamic_amm() view returns (bytes32)",
    "function prog_dynamic_vault() view returns (bytes32)",
    "function cpi_program() view returns (address)",
    "function pool_factory() view returns (address)",
    "function token_factory() view returns (address)",
]);

function b58(hex: string): string { return bs58.encode(Buffer.from(hex.slice(2), 'hex')); }
async function main() {
    const { viem } = await hardhat.network.connect() as any;
    const pc = await viem.getPublicClient();
    const inner = await pc.readContract({ address: OUTER, abi: outerAbi, functionName: "internal_pool" }) as `0x${string}`;
    for (const f of ["prog_dynamic_amm","prog_dynamic_vault","cpi_program","pool_factory","token_factory"]) {
        try {
            const v = await pc.readContract({ address: inner, abi: innerAbi, functionName: f as any });
            if ((v as string).length === 66) {
                const enc = b58(v as string);
                const mark = enc === "BctLf2Q2KxwYHwDd584NxUzECjgoHeTfQX2LqCBcGjdm" ? " <-- BctLf2Q!" : "";
                console.log(`  ${f.padEnd(22)} ${v} = ${enc}${mark}`);
            } else {
                console.log(`  ${f.padEnd(22)} ${v}`);
            }
        } catch (e: any) { console.log(`  ${f.padEnd(22)} REVERT`); }
    }
}
main().catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
