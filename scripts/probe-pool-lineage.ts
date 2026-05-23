import hardhat from "hardhat";
import { parseAbi } from "viem";

const POOL_OUTER = "0x4B7EB70311fD0752d270Ca1017CC49845c305321"; // ERC20DAMMv1Pool
const METEORA_V3 = "0xd68b355f62643de0ec40243cba8f699f959ea3c4";
const METEORA_V2 = "0xa3a4a27567f12133f3fe90c11403518c922de185";
const METEORA_V1 = "0x040f9c2671b2b0c70b32c10727afcdbbf23b92fb";

const TF_V3 = "0x3c971ea1c7cf7a1b0a8af46f8a9e0648a82f9869";
const TF_V2 = "0x21cc267ff924aeca4de781db9b5bdf7a4c495e72";
const TF_V1 = "0xf4504274e1a383146c39935bd5eff2edbb193c37";

const WUSDC = "0x9fD4D58dbB041CaFF77d323d2410c16DE339eB18";
const WSOL  = "0x28E7c064E734cB3edeA65A98927c1c20581c8934";

// ERC20DAMMv1Pool exposes pool_factory + internal_pool
const outerAbi = parseAbi([
    "function internal_pool() view returns (address)",
    "function pool_factory() view returns (address)",
    "function token_factory() view returns (address)",
]);
const innerAbi = parseAbi([
    "function pool_factory() view returns (address)",
    "function token_factory() view returns (address)",
]);
const metoFactoryAbi = parseAbi([
    "function getPool(address,address) view returns (address)",
    "function token_factory() view returns (address)",
]);

async function tryRead(pc: any, addr: string, abi: any, fn: string, args: any[] = []): Promise<any> {
    try { return await pc.readContract({ address: addr as `0x${string}`, abi, functionName: fn as any, args }); }
    catch { return "<revert>"; }
}

async function main() {
    const { viem } = await hardhat.network.connect() as any;
    const pc = await viem.getPublicClient();

    console.log("=== Pool wrapper (outer ERC20DAMMv1Pool) ===");
    const inner = await tryRead(pc, POOL_OUTER, outerAbi, "internal_pool");
    const outerTf = await tryRead(pc, POOL_OUTER, outerAbi, "token_factory");
    console.log(`  outer:         ${POOL_OUTER}`);
    console.log(`  internal_pool: ${inner}`);
    console.log(`  token_factory: ${outerTf}`);
    console.log();
    if (inner !== "<revert>") {
        const ipool_factory = await tryRead(pc, inner as string, innerAbi, "pool_factory");
        console.log(`  inner.pool_factory:  ${ipool_factory}`);
    }
    console.log();

    console.log("=== Each Meteora factory version: does it know about this pool? ===");
    for (const [label, mf] of [["v3 LIVE", METEORA_V3], ["v2 RETIRED", METEORA_V2], ["v1 RETIRED", METEORA_V1]]) {
        const p = await tryRead(pc, mf, metoFactoryAbi, "getPool", [WUSDC, WSOL]);
        const tf = await tryRead(pc, mf, metoFactoryAbi, "token_factory");
        const isPool = String(p).toLowerCase() === POOL_OUTER.toLowerCase();
        console.log(`  ${label.padEnd(11)} ${mf}`);
        console.log(`    getPool(wUSDC,wSOL): ${p}  ${isPool ? "← this is our pool" : ""}`);
        console.log(`    token_factory:       ${tf}`);
    }
}
main().catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
