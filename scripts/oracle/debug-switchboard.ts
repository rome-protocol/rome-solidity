import hardhat from "hardhat";

/**
 * Debug Switchboard V2 account — brute-force find the latest_confirmed_round result.
 *
 * Switchboard V2 AggregatorAccountData struct layout (from switchboard-v2 crate):
 *   - discriminator: 8 bytes
 *   - name: 32 bytes [8..40]
 *   - metadata: 128 bytes [40..168]
 *   - ... many config fields ...
 *   - latest_confirmed_round: AggregatorRound
 *     - AggregatorRound has: num_success, num_error, is_closed, round_open_slot,
 *       round_open_timestamp, result (SwitchboardDecimal), std_deviation, ...
 *   - SwitchboardDecimal = { mantissa: i128 (16 bytes), scale: u32 (4 bytes) }
 *
 * Strategy: scan for any (i128 mantissa, u32 scale) pair where the resulting
 * price is $50-$200 (SOL range), with scale 6-12.
 */

async function main() {
    const { viem } = await hardhat.network.connect();

    const cpi = await viem.getContractAt(
        "ICrossProgramInvocation",
        "0xFF00000000000000000000000000000000000008",
    );

    const solAgg = "0xec81105112a257d61df4cf5f13ee0a1b019197c8c5343b4f2a7ec8846ae22c1a" as const;
    const [, , , , , data] = await cpi.read.account_info([solAgg]);
    const hex = data.slice(2);
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    console.log(`Data length: ${bytes.length} bytes`);

    // Name at [8..40]
    const nameBytes = bytes.slice(8, 40);
    const name = new TextDecoder().decode(nameBytes).replace(/\0/g, "");
    console.log(`Name: "${name}"`);

    // Search for (mantissa i128, scale u32) pairs where price is reasonable
    console.log("\n--- Brute-force scanning for SwitchboardDecimal ---");

    for (let offset = 100; offset < bytes.length - 20; offset++) {
        // Read i128 LE
        let mantissa = 0n;
        for (let i = 0; i < 16; i++) {
            mantissa |= BigInt(bytes[offset + i]) << BigInt(i * 8);
        }
        if (mantissa >= (1n << 127n)) mantissa -= (1n << 128n);

        // Read u32 LE scale
        let scale = 0;
        for (let i = 0; i < 4; i++) {
            scale |= bytes[offset + 16 + i] << (i * 8);
        }

        if (scale < 1 || scale > 18 || mantissa <= 0n) continue;

        const price = Number(mantissa) / Math.pow(10, scale);
        if (price < 10 || price > 500) continue;

        // Check for timestamp nearby (before the result, round_open_timestamp is i64)
        // In AggregatorRound: round_open_slot (u64) then round_open_timestamp (i64) come BEFORE result
        // So check offset-24 and offset-16 for timestamp
        for (const tsOff of [offset - 16, offset - 8, offset + 20, offset + 28]) {
            if (tsOff < 0 || tsOff + 8 > bytes.length) continue;
            let ts = 0n;
            for (let i = 0; i < 8; i++) {
                ts |= BigInt(bytes[tsOff + i]) << BigInt(i * 8);
            }
            if (ts >= 1700000000n && ts <= 1800000000n) {
                console.log(`  MATCH offset=${offset}: mantissa=${mantissa}, scale=${scale}, price=$${price.toFixed(6)}`);
                console.log(`    timestamp at offset ${tsOff}: ${ts} (${new Date(Number(ts) * 1000).toISOString()})`);

                // Also show the slot
                const slotOff = tsOff - 8;
                if (slotOff >= 0) {
                    let slot = 0n;
                    for (let i = 0; i < 8; i++) {
                        slot |= BigInt(bytes[slotOff + i]) << BigInt(i * 8);
                    }
                    if (slot > 100000000n && slot < 1000000000n) {
                        console.log(`    slot at offset ${slotOff}: ${slot}`);
                    }
                }
            }
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
