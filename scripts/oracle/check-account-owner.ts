import hardhat from "hardhat";

/**
 * Debug script: check the owner of Solana accounts via CPI precompile.
 */

const ACCOUNTS: Record<string, `0x${string}`> = {
    // Pyth Pull PriceFeedAccount PDAs (shard_id=0)
    "SOL/USD pull PDA": "0x60314704340deddf371fd42472148f248e9d1a6d1a5eb2ac3acd8b7fd5d6b243",
    "BTC/USD pull PDA": "0x35a70c11162fbf5a0e7f7d2f96e19f97b02246a15687ee672794897448e658de",
    "ETH/USD pull PDA": "0x2cfad277afcaa867c7d7fe26e0d51dc899101335879ab63c2aa84876317135bb",
    // Pyth V2 push accounts (from V1 test-feeds.ts)
    "SOL/USD v1 push": "0xfe650f0367d4a7ef9815a593ea15d36593f0643aaaf0149bb04be67ab851decd",
    "BTC/USD v1 push": "0xf9c0172ba10dfa4d19088d94f5bf61d3b54d5bd7483a322a982e1373ee8ea31b",
    "ETH/USD v1 push": "0xca80ba6dc32e08d06f1aa886011eed1d77c77be9eb761cc10d72b7d0a2fd57a6",
};

// Known program IDs for comparison
const PROGRAMS: Record<string, string> = {
    "0x0c4aa0128e95d3e1622aa501c585a9eb07b37354c108ea0b791b456dc7eea336": "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT (Price Feed)",
    "0x0a1a9833a376552b56b7ca0ded1929170057e827a0c627f4b647b9ee9099afb4": "gSbePebfvPy7tRqimPoVecS2UsBvYv46ynrzWocc92s (Pyth V2 Push)",
    "0x0cb7fabb52f7a648bb5b317d9a018b9057cb024774fafe01e6c4df98cc385881": "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ (Receiver)",
};

async function main() {
    const { viem } = await hardhat.network.connect();

    const cpi = await viem.getContractAt(
        "ICrossProgramInvocation",
        "0xFF00000000000000000000000000000000000008",
    );

    for (const [name, pubkey] of Object.entries(ACCOUNTS)) {
        try {
            const [lamports, owner, isSigner, isWritable, executable, data] =
                await cpi.read.account_info([pubkey]);
            const ownerHex = owner.toLowerCase();
            const knownProgram = PROGRAMS[ownerHex] ?? "UNKNOWN";
            console.log(`${name}:`);
            console.log(`  lamports: ${lamports}`);
            console.log(`  owner: ${ownerHex}`);
            console.log(`  program: ${knownProgram}`);
            console.log(`  data length: ${(data.length - 2) / 2} bytes`);
            console.log(`  first 16 bytes: ${data.slice(0, 34)}`);
        } catch (e: any) {
            console.log(`${name}: ERROR — ${e.message?.slice(0, 80)}`);
        }
        console.log();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
