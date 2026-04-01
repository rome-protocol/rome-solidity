import hardhat from "hardhat";

async function main() {
    const { viem } = await hardhat.network.connect();

    // Deploy a fresh parser harness
    const parser = await viem.deployContract("PythPullParserHarness", []);

    const cpi = await viem.getContractAt(
        "ICrossProgramInvocation",
        "0xFF00000000000000000000000000000000000008",
    );

    const solPda = "0x60314704340deddf371fd42472148f248e9d1a6d1a5eb2ac3acd8b7fd5d6b243" as const;

    // Read raw data
    const [lamports, owner, , , , data] = await cpi.read.account_info([solPda]);
    console.log("Raw data length:", (data.length - 2) / 2, "bytes");
    console.log("First 20 bytes:", data.slice(0, 42));
    // Dump full hex with offset annotations
    const hex = data.slice(2); // strip 0x
    console.log("\nFull hex dump with offsets:");
    for (let i = 0; i < hex.length; i += 64) {
        const offset = i / 2;
        const chunk = hex.slice(i, i + 64);
        console.log(`  [${offset.toString().padStart(3)}] ${chunk}`);
    }

    // Parse via harness
    const [price, conf, expo, publishTime, emaPrice, emaConf] =
        await parser.read.parse([data]);
    console.log("\nParsed:");
    console.log("  price:", price.toString());
    console.log("  conf:", conf.toString());
    console.log("  expo:", expo);
    console.log("  publishTime:", publishTime.toString());
    console.log("  publishTime date:", new Date(Number(publishTime) * 1000).toISOString());
    console.log("  emaPrice:", emaPrice.toString());
    console.log("  emaConf:", emaConf.toString());

    // Get block timestamp
    const publicClient = await viem.getPublicClient();
    const block = await publicClient.getBlock();
    console.log("\n  block.timestamp:", block.timestamp.toString());
    console.log("  block.timestamp date:", new Date(Number(block.timestamp) * 1000).toISOString());
    console.log("  diff:", Number(block.timestamp) - Number(publishTime), "seconds");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
