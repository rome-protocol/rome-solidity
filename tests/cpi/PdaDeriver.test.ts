import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/**
 * Tests for PdaDeriver seed helpers + N-arg makeSeeds.
 *
 * The on-chain `derive` path requires the System Program precompile
 * (find_program_address), which doesn't exist on hardhatMainnet. It's
 * exercised end-to-end via live adapter integration tests.
 */

describe("PdaDeriver", () => {
    let wrapper: any;

    before(async () => {
        const { viem } = await hardhat.network.connect();
        wrapper = await viem.deployContract("PdaDeriverWrapper", []);
    });

    it("seedBytes(bytes32) returns 32-byte packed pubkey", async () => {
        const key = ("0x" + "aa".repeat(32)) as `0x${string}`;
        const got: string = (await wrapper.read.seedBytesPubkey([key])) as string;
        assert.equal(got.toLowerCase(), key.toLowerCase());
    });

    it("seedBytes(string) returns utf8 bytes", async () => {
        const got: string = (await wrapper.read.seedBytesString([
            "EXTERNAL_AUTHORITY",
        ])) as string;
        // "EXTERNAL_AUTHORITY" utf8 = 0x45585445524e414c5f415554484f52495459
        assert.equal(
            got.toLowerCase(),
            "0x45585445524e414c5f415554484f52495459",
        );
    });

    it("seedBytes(uint8) returns single byte", async () => {
        const got: string = (await wrapper.read.seedBytesU8([42])) as string;
        assert.equal(got.toLowerCase(), "0x2a");
    });

    it("seedBytesU16Le returns little-endian 2 bytes", async () => {
        const got: string = (await wrapper.read.seedBytesU16Le([0x1234])) as string;
        // 0x1234 LE = 0x3412
        assert.equal(got.toLowerCase(), "0x3412");
    });

    it("makeSeeds builds 2-arg array", async () => {
        const got = await wrapper.read.makeSeeds2([
            ("0x" + "11".repeat(32)) as `0x${string}`,
            ("0x" + "22".repeat(32)) as `0x${string}`,
        ]);
        assert.equal(got, 2n);
    });

    it("makeSeeds builds 3-arg array", async () => {
        const got = await wrapper.read.makeSeeds3([
            ("0x" + "11".repeat(32)) as `0x${string}`,
            ("0x" + "22".repeat(32)) as `0x${string}`,
            ("0x" + "33".repeat(32)) as `0x${string}`,
        ]);
        assert.equal(got, 3n);
    });

    it("makeSeeds builds 6-arg array (Kamino Vanilla obligation shape)", async () => {
        const got = await wrapper.read.makeSeeds6([
            0,
            0,
            ("0x" + "11".repeat(32)) as `0x${string}`,
            ("0x" + "22".repeat(32)) as `0x${string}`,
        ]);
        assert.equal(got, 6n);
    });
});
