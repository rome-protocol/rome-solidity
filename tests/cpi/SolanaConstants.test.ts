import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import bs58 from "bs58";

/**
 * Cross-check every SolanaConstants constant against its canonical bs58
 * decoding. If the Solidity side drifts from the bs58-canonical pubkey,
 * one of these assertions fails — no need to trust the hex in the .sol file.
 *
 * Reference pubkeys taken from:
 *   - Solana runtime: 11111...111 (System), Sysvar*
 *   - SPL Token program: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
 *   - Associated Token: ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
 *   - Token-2022: TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
 */

const CANONICAL: Record<string, string> = {
    SYSTEM_PROGRAM: "11111111111111111111111111111111",
    SYSVAR_RENT: "SysvarRent111111111111111111111111111111111",
    SYSVAR_INSTRUCTIONS: "Sysvar1nstructions1111111111111111111111111",
    SYSVAR_CLOCK: "SysvarC1ock11111111111111111111111111111111",
    SPL_TOKEN_PROGRAM: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    ASSOCIATED_TOKEN_PROGRAM: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    TOKEN_2022_PROGRAM: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
};

function bs58ToBytes32(b58: string): `0x${string}` {
    const dec = bs58.decode(b58);
    if (dec.length !== 32) {
        throw new Error(`bs58 decoded length != 32 for ${b58}`);
    }
    return ("0x" + Buffer.from(dec).toString("hex")) as `0x${string}`;
}

describe("SolanaConstants", () => {
    let harness: any;

    before(async () => {
        const { viem } = await hardhat.network.connect();
        harness = await viem.deployContract("SolanaConstantsHarness", []);
    });

    for (const [name, b58] of Object.entries(CANONICAL)) {
        it(`${name} matches bs58-decoded ${b58}`, async () => {
            const expected = bs58ToBytes32(b58);
            const actual = await harness.read[name]();
            assert.equal(
                (actual as string).toLowerCase(),
                expected.toLowerCase(),
                `${name}: expected ${expected}, got ${actual}`,
            );
        });
    }

    it("SYSTEM_PROGRAM is the all-zero pubkey", async () => {
        const sp = await harness.read.SYSTEM_PROGRAM();
        assert.equal(
            (sp as string).toLowerCase(),
            "0x" + "00".repeat(32),
        );
    });
});
