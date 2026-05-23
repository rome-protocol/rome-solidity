import hardhat from "hardhat";
import { parseAbi, encodeFunctionData } from "viem";
import bs58 from "bs58";

// Activator already created the user's wSOL ATA; calling create_ata directly should be idempotent no-op
const HELPER = "0xff00000000000000000000000000000000000009";
const WSOL_MINT_B58 = "So11111111111111111111111111111111111111112";
const WUSDC_MINT_B58 = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const USER = "0x1f4946be340f06c46a50e65084790968abcc48f6";

function b58_to_b32(s: string): `0x${string}` { return ("0x" + Buffer.from(bs58.decode(s)).toString("hex")) as `0x${string}`; }

async function main() {
    const { viem } = await hardhat.network.connect() as any;
    const pc = await viem.getPublicClient();
    const [d] = await viem.getWalletClients();

    // Try direct calls (will revert because msg.sender = user EOA, not a contract; signer requirement may differ)
    // Instead, deploy a tiny probe that delegate-calls HelperProgram.create_ata
    const probeAbi = parseAbi([
        "function tryCreateAta(bytes32 mint) external"
    ]);
    
    // Use SimpleActivator as the probe — it can ensure_ata via the helper. But its activate() is one-shot.
    // Better: just call estimate_gas directly to see if create_ata reverts at the emulation level
    
    for (const [label, mintB58] of [["wUSDC", WUSDC_MINT_B58], ["wSOL", WSOL_MINT_B58]]) {
        const mintB32 = b58_to_b32(mintB58);
        const data = encodeFunctionData({
            abi: parseAbi(["function create_ata(address user, bytes32 mint)"]),
            functionName: "create_ata",
            args: [USER, mintB32],
        });
        console.log(`\n--- direct eth_call to HelperProgram.create_ata(user, ${label} mint) ---`);
        try {
            const r = await pc.call({ to: HELPER, data, account: USER as `0x${string}` });
            console.log(`  OK: ${r.data || "<no return data>"}`);
        } catch (e: any) {
            console.log(`  REVERT: ${e.shortMessage || e.message}`);
        }
    }
}
main().catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
