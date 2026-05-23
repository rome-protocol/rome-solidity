// Probe createPermissionlessConstantProductPoolWithConfig2 on the new factory.
// Goal: find a Meteora config + verify create-pool path executes correctly.
import hardhat from "hardhat";
import { parseAbi } from "viem";
import bs58 from "bs58";

const FACTORY = "0x6ce0e90db2b54b9a433530cd5b3d31573a401c3e";
const USDC_MINT_B58 = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SOL_MINT_B58  = "So11111111111111111111111111111111111111112";
const SOLANA_RPC = "https://node1.devnet-eu-sol-api.devnet.romeprotocol.xyz";

function b58_to_b32(s: string): `0x${string}` {
    return ("0x" + Buffer.from(bs58.decode(s)).toString("hex")) as `0x${string}`;
}
function b32_to_b58(h: string): string {
    return bs58.encode(Buffer.from(h.slice(2), "hex"));
}
async function solRpc(method: string, params: any[]): Promise<any> {
    const r = await fetch(SOLANA_RPC, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({jsonrpc:"2.0",id:1,method,params}),
    });
    return await r.json();
}
async function exists(b58: string): Promise<boolean> {
    const r = await solRpc("getAccountInfo", [b58, {encoding:"base64"}]);
    return r?.result?.value !== null;
}

async function main() {
    const { viem } = await hardhat.network.connect() as any;
    const pc = await viem.getPublicClient();

    const factoryAbi = parseAbi([
        "function deriveConfigKey(uint64 index) view returns (bytes32)",
        "function preparePermissionlessConstantProductPoolWithConfig2(bytes32 a, bytes32 b, bytes32 config) view returns ((bytes32 pool, bytes32 config, bytes32 lp_mint, bytes32 token_a_mint, bytes32 token_b_mint, bytes32 a_vault, bytes32 b_vault, bytes32 a_token_vault, bytes32 b_token_vault, bytes32 a_vault_lp_mint, bytes32 b_vault_lp_mint, bytes32 a_vault_lp, bytes32 b_vault_lp, bytes32 payer_token_a, bytes32 payer_token_b, bytes32 payer_pool_lp, bytes32 protocol_token_a_fee, bytes32 protocol_token_b_fee, bytes32 payer, bytes32 rent, bytes32 vault_program, bytes32 token_program, bytes32 associated_token_program, bytes32 system_program, bytes32 metadata_program, bytes32 mint_metadata))",
    ]);

    // Probe config indexes 0..5
    console.log("--- probing Meteora dynamic-amm configs on devnet ---");
    let validConfig: string | null = null;
    for (let i = 0; i < 6; i++) {
        const cfg = await pc.readContract({ address: FACTORY as `0x${string}`, abi: factoryAbi, functionName: "deriveConfigKey", args: [BigInt(i)] }) as `0x${string}`;
        const cfg_b58 = b32_to_b58(cfg);
        const ex = await exists(cfg_b58);
        console.log(`  index=${i}  config=${cfg_b58}  exists=${ex}`);
        if (ex && !validConfig) validConfig = cfg_b58;
    }
    if (!validConfig) {
        console.log("\nNO valid configs found at indexes 0..5. Cannot test createPool without one.");
        return;
    }
    console.log(`\nUsing config: ${validConfig}`);

    // Derive prepared accounts for USDC × SOL × validConfig
    const usdcB32 = b58_to_b32(USDC_MINT_B58);
    const solB32  = b58_to_b32(SOL_MINT_B58);
    const cfgB32  = b58_to_b32(validConfig);
    
    console.log(`\n--- preparePermissionlessConstantProductPoolWithConfig2(USDC, SOL, config) ---`);
    try {
        const accts = await pc.readContract({
            address: FACTORY as `0x${string}`,
            abi: factoryAbi,
            functionName: "preparePermissionlessConstantProductPoolWithConfig2",
            args: [usdcB32, solB32, cfgB32],
        }) as any;
        console.log(`  pool:               ${b32_to_b58(accts.pool)}`);
        console.log(`  a_vault:            ${b32_to_b58(accts.a_vault)}`);
        console.log(`  b_vault:            ${b32_to_b58(accts.b_vault)}`);
        console.log(`  lp_mint:            ${b32_to_b58(accts.lp_mint)}`);
        console.log(`  payer:              ${b32_to_b58(accts.payer)}`);
        
        // Check existence
        const poolExists = await exists(b32_to_b58(accts.pool));
        const aVaultExists = await exists(b32_to_b58(accts.a_vault));
        const bVaultExists = await exists(b32_to_b58(accts.b_vault));
        console.log(`\n  pool exists on Solana:    ${poolExists}`);
        console.log(`  a_vault exists on Solana: ${aVaultExists}`);
        console.log(`  b_vault exists on Solana: ${bVaultExists}`);
        console.log(`\n  Preconditions for createPermissionless...:`);
        console.log(`    !a_vault_missing:  ${aVaultExists ? '✓' : '✗ FAIL'}`);
        console.log(`    !b_vault_missing:  ${bVaultExists ? '✓' : '✗ FAIL'}`);
        console.log(`    pool_missing:      ${poolExists ? '✗ EXISTS, cannot create' : '✓'}`);
        
        if (poolExists) {
            console.log(`\n  This pool already exists. Cannot test create — would need a different config or token pair.`);
        } else if (aVaultExists && bVaultExists) {
            console.log(`\n  ✓ All preconditions met. CREATE is callable for these inputs.`);
        }
    } catch (e: any) {
        console.log(`  REVERT: ${e.shortMessage || e.message}`);
    }
}
main().catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
