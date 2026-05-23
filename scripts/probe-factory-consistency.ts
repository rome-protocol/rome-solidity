import hardhat from "hardhat";
import { parseAbi } from "viem";
import bs58 from "bs58";

// 3 factory versions per registry contracts.json
const FACTORY_V3 = "0x3c971ea1c7cf7a1b0a8af46f8a9e0648a82f9869"; // LIVE
const FACTORY_V2 = "0x21cc267ff924aeca4de781db9b5bdf7a4c495e72"; // RETIRED
const FACTORY_V1 = "0xf4504274e1a383146c39935bd5eff2edbb193c37"; // RETIRED

const METEORA_V3 = "0xd68b355f62643de0ec40243cba8f699f959ea3c4"; // LIVE Meteora factory
const WUSDC = "0x9fD4D58dbB041CaFF77d323d2410c16DE339eB18";
const WSOL  = "0x28E7c064E734cB3edeA65A98927c1c20581c8934";
const USER = "0x1f4946be340f06c46a50e65084790968abcc48f6";

const tfAbi = parseAbi([
    "function token_by_mint(bytes32) view returns (address)",
    "function mint_by_token(address) view returns (bytes32)",
    "function users() view returns (address)",
    "function _users() view returns (address)",
]);
const meteoraAbi = parseAbi([
    "function token_factory() view returns (address)",
    "function prog_dynamic_amm() view returns (bytes32)",
    "function prog_dynamic_vault() view returns (bytes32)",
]);
const wrapperAbi = parseAbi([
    "function mint_id() view returns (bytes32)",
    "function _users() view returns (address)",
    "function users() view returns (address)",
    "function symbol() view returns (string)",
    "function token_factory() view returns (address)",
    "function _factory() view returns (address)",
    "function factory() view returns (address)",
]);
const usersAbi = parseAbi([
    "function is_registered(address) view returns (bool)",
    "function get_user(address) view returns (uint256)",
]);

const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SOL_MINT = "So11111111111111111111111111111111111111112";
function b58_to_b32(s: string): `0x${string}` {
    return ("0x" + Buffer.from(bs58.decode(s)).toString("hex")) as `0x${string}`;
}
function b32_to_b58(h: string): string { return bs58.encode(Buffer.from(h.slice(2), "hex")); }

async function tryRead(pc: any, addr: string, abi: any, fn: string, args: any[] = []): Promise<any> {
    try { return await pc.readContract({ address: addr as `0x${string}`, abi, functionName: fn as any, args }); }
    catch { return "<revert>"; }
}

async function main() {
    const { viem } = await hardhat.network.connect() as any;
    const pc = await viem.getPublicClient();

    console.log("=== Meteora v3 factory points at which token_factory? ===");
    const tf_via_meteora = await tryRead(pc, METEORA_V3, meteoraAbi, "token_factory");
    console.log(`  Meteora.token_factory: ${tf_via_meteora}`);
    console.log(`  Expected v3 factory:   ${FACTORY_V3}`);
    console.log(`  Match: ${String(tf_via_meteora).toLowerCase() === FACTORY_V3.toLowerCase()}\n`);

    console.log("=== token_by_mint across factory versions ===");
    const usdcB32 = b58_to_b32(USDC_MINT);
    const solB32 = b58_to_b32(SOL_MINT);
    for (const [label, f] of [["v3 LIVE", FACTORY_V3], ["v2 RETIRED", FACTORY_V2], ["v1 RETIRED", FACTORY_V1]]) {
        const wUsdc_addr = await tryRead(pc, f, tfAbi, "token_by_mint", [usdcB32]);
        const wSol_addr = await tryRead(pc, f, tfAbi, "token_by_mint", [solB32]);
        console.log(`  ${label.padEnd(11)} ${f}`);
        console.log(`    → wUSDC: ${wUsdc_addr}`);
        console.log(`    → wSOL:  ${wSol_addr}`);
    }
    console.log();

    console.log("=== users registry per factory ===");
    for (const [label, f] of [["v3 LIVE", FACTORY_V3], ["v2 RETIRED", FACTORY_V2], ["v1 RETIRED", FACTORY_V1]]) {
        const u1 = await tryRead(pc, f, tfAbi, "users");
        const u2 = await tryRead(pc, f, tfAbi, "_users");
        console.log(`  ${label.padEnd(11)} users=${u1}  _users=${u2}`);
    }
    console.log();

    console.log("=== Wrapper introspection ===");
    for (const [label, w] of [["wUSDC", WUSDC], ["wSOL", WSOL]]) {
        const sym = await tryRead(pc, w, wrapperAbi, "symbol");
        const mid = await tryRead(pc, w, wrapperAbi, "mint_id");
        const u1 = await tryRead(pc, w, wrapperAbi, "_users");
        const u2 = await tryRead(pc, w, wrapperAbi, "users");
        const tf = await tryRead(pc, w, wrapperAbi, "token_factory");
        const tf2 = await tryRead(pc, w, wrapperAbi, "_factory");
        const tf3 = await tryRead(pc, w, wrapperAbi, "factory");
        const midDecoded = typeof mid === "string" && mid.startsWith("0x") && mid !== "<revert>" ? b32_to_b58(mid) : mid;
        console.log(`  ${label} (${w})`);
        console.log(`    symbol:        ${sym}`);
        console.log(`    mint_id:       ${midDecoded}`);
        console.log(`    _users:        ${u1}`);
        console.log(`    users:         ${u2}`);
        console.log(`    token_factory: ${tf}`);
        console.log(`    _factory:      ${tf2}`);
        console.log(`    factory:       ${tf3}`);
    }
    console.log();

    console.log("=== Is user registered? Check each factory's users registry ===");
    for (const [label, f] of [["v3 LIVE", FACTORY_V3], ["v2 RETIRED", FACTORY_V2], ["v1 RETIRED", FACTORY_V1]]) {
        const u = await tryRead(pc, f, tfAbi, "users");
        if (u === "<revert>" || u === "0x0000000000000000000000000000000000000000") {
            console.log(`  ${label.padEnd(11)} users=<not readable>`);
            continue;
        }
        const isReg = await tryRead(pc, u as string, usersAbi, "is_registered", [USER]);
        console.log(`  ${label.padEnd(11)} users=${u}  is_registered(${USER})=${isReg}`);
    }
}
main().catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
