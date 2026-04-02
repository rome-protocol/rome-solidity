import hardhat from "hardhat";

/**
 * Check Switchboard accounts on Rome's fork.
 */

const ACCOUNTS: Record<string, `0x${string}`> = {
    "SOL/USD (SB V2)": "0xec81105112a257d61df4cf5f13ee0a1b019197c8c5343b4f2a7ec8846ae22c1a",
    "BTC/USD (SB V2)": "0xabc6cd81621fa075cc40f28cce30cf33f34c7758b96ae21a100d81b1ec112db6",
};

const KNOWN_PROGRAMS: Record<string, string> = {
    "0x068851c68c6832f02fa581b1bf491b77ca41776ba2b988b5a6faba8ee3a2ec90": "SW1TCH (Switchboard V2)",
    "0x0673bd46f2e47e04f12bd92fb731968ecd9d9757c274da87476f465c040c6573": "SBond (Switchboard On-Demand)",
};

async function main() {
    const { viem } = await hardhat.network.connect();

    const cpi = await viem.getContractAt(
        "ICrossProgramInvocation",
        "0xFF00000000000000000000000000000000000008",
    );

    for (const [name, pubkey] of Object.entries(ACCOUNTS)) {
        try {
            const [lamports, owner, , , , data] =
                await cpi.read.account_info([pubkey]);
            const ownerHex = owner.toLowerCase();
            const program = KNOWN_PROGRAMS[ownerHex] ?? `UNKNOWN (${ownerHex})`;
            const dataLen = (data.length - 2) / 2;
            console.log(`${name}:`);
            console.log(`  lamports: ${lamports}`);
            console.log(`  owner: ${program}`);
            console.log(`  data: ${dataLen} bytes`);
            console.log(`  first 16 bytes: ${data.slice(0, 34)}`);

            // Try to decode discriminator
            const disc = data.slice(0, 18); // 0x + 8 bytes
            console.log(`  discriminator: ${disc}`);
        } catch (e: any) {
            console.log(`${name}: ERROR — ${e.message?.slice(0, 100)}`);
        }
        console.log();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
