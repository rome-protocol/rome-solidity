import hardhat from "hardhat";
import { parseAbi } from "viem";
import bs58 from "bs58";

const POOL_WRAPPER = "0x4B7EB70311fD0752d270Ca1017CC49845c305321";
const abi = parseAbi([
    "function update_state() external",
    "function pool_address() view returns (bytes32)",
    "function token_a_mint() view returns (bytes32)",
    "function token_b_mint() view returns (bytes32)",
    "function lp_mint() view returns (bytes32)",
    "function a_vault() view returns (bytes32)",
    "function b_vault() view returns (bytes32)",
    "function protocol_token_a_fee() view returns (bytes32)",
    "function protocol_token_b_fee() view returns (bytes32)",
]);

function b32_to_b58(hex: string): string {
    return bs58.encode(Buffer.from(hex.slice(2), 'hex'));
}

async function main() {
    const { viem } = await hardhat.network.connect() as any;
    const pc = await viem.getPublicClient();
    const [deployer] = await viem.getWalletClients();

    console.log("--- BEFORE update_state ---");
    for (const f of ["pool_address","token_a_mint","token_b_mint","lp_mint","a_vault","b_vault"]) {
        try {
            const v = await pc.readContract({ address: POOL_WRAPPER, abi, functionName: f as any }) as `0x${string}`;
            console.log(`  ${f.padEnd(24)} ${b32_to_b58(v)}`);
        } catch { console.log(`  ${f.padEnd(24)} REVERT`); }
    }

    console.log("\n--- calling update_state ---");
    const pw = await viem.getContractAt("DAMMv1Pool", POOL_WRAPPER);
    try {
        const txHash = await pw.write.update_state({ account: deployer.account });
        const rc = await pc.waitForTransactionReceipt({ hash: txHash });
        console.log(`  tx=${txHash} status=${rc.status} gas=${rc.gasUsed}`);
    } catch (e: any) {
        console.log(`  REVERTED: ${e.shortMessage || e.message}`);
    }

    console.log("\n--- AFTER update_state ---");
    for (const f of ["pool_address","token_a_mint","token_b_mint","lp_mint","a_vault","b_vault","protocol_token_a_fee","protocol_token_b_fee"]) {
        try {
            const v = await pc.readContract({ address: POOL_WRAPPER, abi, functionName: f as any }) as `0x${string}`;
            const b58 = b32_to_b58(v);
            const mark = b58 === "BctLf2Q2KxwYHwDd584NxUzECjgoHeTfQX2LqCBcGjdm" ? " <-- BctLf2Q!" : "";
            console.log(`  ${f.padEnd(24)} ${b58}${mark}`);
        } catch { console.log(`  ${f.padEnd(24)} REVERT`); }
    }
}
main().catch(e => { console.error(e); process.exit(1); });
