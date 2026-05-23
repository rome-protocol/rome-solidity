import hardhat from "hardhat";
import { parseAbi } from "viem";
import bs58 from "bs58";

const WUSDC = "0x9fD4D58dbB041CaFF77d323d2410c16DE339eB18";
const WSOL  = "0x28E7c064E734cB3edeA65A98927c1c20581c8934";
const abi = parseAbi([
    "function mint_id() view returns (bytes32)",
    "function symbol() view returns (string)",
]);

function b58(hex: string): string { return bs58.encode(Buffer.from(hex.slice(2), 'hex')); }
async function main() {
    const { viem } = await hardhat.network.connect() as any;
    const pc = await viem.getPublicClient();
    for (const w of [["wUSDC",WUSDC],["wSOL",WSOL]]) {
        const sym = await pc.readContract({ address: w[1] as `0x${string}`, abi, functionName: "symbol" }) as string;
        const mid = await pc.readContract({ address: w[1] as `0x${string}`, abi, functionName: "mint_id" }) as `0x${string}`;
        const mark = b58(mid) === "BctLf2Q2KxwYHwDd584NxUzECjgoHeTfQX2LqCBcGjdm" ? " <-- BctLf2Q!" : "";
        console.log(`  ${w[0]} (${w[1]})  symbol=${sym}  mint_id=${b58(mid)}${mark}`);
    }
}
main().catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
