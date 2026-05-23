import hardhat from "hardhat";
import { parseAbi } from "viem";
const POOL_OUTER = "0x8f104482e81A9A56C3e6F37C76f9a4878f96aEB8";
async function main() {
    const { viem } = await hardhat.network.connect() as any;
    const pc = await viem.getPublicClient();
    const reserves = await pc.readContract({
        address: POOL_OUTER,
        abi: parseAbi(["function get_reserves() view returns ((uint64 a_amount, uint64 b_amount))"]),
        functionName: "get_reserves",
    }) as any;
    console.log(`a_amount (wUSDC, 6dec): ${reserves.a_amount} = ${Number(reserves.a_amount)/1e6} USDC`);
    console.log(`b_amount (wSOL, 9dec):  ${reserves.b_amount} = ${Number(reserves.b_amount)/1e9} SOL`);
    console.log(`implied price: 1 SOL = ${(Number(reserves.a_amount)/1e6) / (Number(reserves.b_amount)/1e9)} USDC`);
}
main().catch(e => { console.error(e.shortMessage || e); process.exit(1); });
