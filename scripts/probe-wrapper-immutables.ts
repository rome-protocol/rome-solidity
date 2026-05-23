import hardhat from "hardhat";
import { parseAbi } from "viem";
import bs58 from "bs58";

const WUSDC = "0x9fD4D58dbB041CaFF77d323d2410c16DE339eB18";
const WSOL  = "0x28E7c064E734cB3edeA65A98927c1c20581c8934";

const abi = parseAbi([
    "function cpi_program() view returns (address)",
    "function mint_id() view returns (bytes32)",
    "function decimals() view returns (uint8)",
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function totalSupply() view returns (uint256)",
]);

function b58(hex: string): string { return bs58.encode(Buffer.from(hex.slice(2), "hex")); }

async function main() {
    const { viem } = await hardhat.network.connect() as any;
    const pc = await viem.getPublicClient();
    for (const [label, w] of [["wUSDC", WUSDC], ["wSOL", WSOL]]) {
        const cpi = await pc.readContract({ address: w as `0x${string}`, abi, functionName: "cpi_program" });
        const mint = await pc.readContract({ address: w as `0x${string}`, abi, functionName: "mint_id" }) as `0x${string}`;
        const dec = await pc.readContract({ address: w as `0x${string}`, abi, functionName: "decimals" });
        const sym = await pc.readContract({ address: w as `0x${string}`, abi, functionName: "symbol" });
        const sup = await pc.readContract({ address: w as `0x${string}`, abi, functionName: "totalSupply" });
        console.log(`  ${label} (${w})`);
        console.log(`    cpi_program: ${cpi}`);
        console.log(`    mint_id:     ${b58(mint)}`);
        console.log(`    decimals:    ${dec}`);
        console.log(`    symbol:      ${sym}`);
        console.log(`    totalSupply: ${sup}`);
    }
}
main().catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
