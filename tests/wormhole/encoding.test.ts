import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

describe("WormholeTokenBridgeEncoding", function () {
    let harness: any;

    before(async function () {
        const { viem } = await hardhat.network.connect();
        harness = await viem.deployContract("WormholeEncodingHarness", []);
    });

    // ──────────────────────────────────────────────
    // encodeCompleteNative
    // ──────────────────────────────────────────────

    it("encodeCompleteNative returns single byte 0x02", async function () {
        const result = await harness.read.encodeCompleteNative();
        assert.equal(result, "0x02");
    });

    // ──────────────────────────────────────────────
    // encodeCompleteWrapped
    // ──────────────────────────────────────────────

    it("encodeCompleteWrapped returns single byte 0x03", async function () {
        const result = await harness.read.encodeCompleteWrapped();
        assert.equal(result, "0x03");
    });

    // ──────────────────────────────────────────────
    // encodeTransferNative — discriminator + payload
    // ──────────────────────────────────────────────

    it("encodeTransferNative starts with discriminator 0x05", async function () {
        const targetAddress = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
        const result: string = await harness.read.encodeTransferNative([
            1,       // nonce
            1000n,   // amount
            0n,      // fee
            targetAddress,
            1,       // targetChain
        ]);

        // First byte should be IX_TRANSFER_NATIVE = 5
        assert.equal(result.slice(0, 4), "0x05");
    });

    it("encodeTransferNative produces 55 bytes (1 discriminator + 54 payload)", async function () {
        const targetAddress = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
        const result: string = await harness.read.encodeTransferNative([
            0,       // nonce
            500n,    // amount
            10n,     // fee
            targetAddress,
            2,       // targetChain
        ]);

        // hex string: "0x" + 55 * 2 hex chars = 112 chars total
        assert.equal(result.length, 2 + 55 * 2);
    });

    it("encodeTransferNative encodes known values correctly", async function () {
        // nonce=1, amount=1000, fee=0, targetAddress=0x00..01, targetChain=1
        const targetAddress = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
        const result: string = await harness.read.encodeTransferNative([
            1,       // nonce
            1000n,   // amount
            0n,      // fee
            targetAddress,
            1,       // targetChain
        ]);

        // Parse out the fields from the hex result
        const bytes = Buffer.from(result.slice(2), "hex");

        // [0] discriminator = 5
        assert.equal(bytes[0], 5);

        // [1..5] nonce LE = 1
        assert.equal(bytes.readUInt32LE(1), 1);

        // [5..13] amount LE = 1000
        assert.equal(bytes.readBigUInt64LE(5), 1000n);

        // [13..21] fee LE = 0
        assert.equal(bytes.readBigUInt64LE(13), 0n);

        // [21..53] targetAddress = 0x00..01
        const targetAddrBytes = bytes.subarray(21, 53);
        assert.equal(targetAddrBytes[31], 1);
        for (let i = 0; i < 31; i++) {
            assert.equal(targetAddrBytes[i], 0, `targetAddress byte ${i} should be 0`);
        }

        // [53..55] targetChain LE = 1
        assert.equal(bytes.readUInt16LE(53), 1);
    });

    // ──────────────────────────────────────────────
    // encodeTransferWrapped — discriminator + payload
    // ──────────────────────────────────────────────

    it("encodeTransferWrapped starts with discriminator 0x04", async function () {
        const targetAddress = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
        const result: string = await harness.read.encodeTransferWrapped([
            1,       // nonce
            1000n,   // amount
            0n,      // fee
            targetAddress,
            1,       // targetChain
        ]);

        // First byte should be IX_TRANSFER_WRAPPED = 4
        assert.equal(result.slice(0, 4), "0x04");
    });

    it("encodeTransferWrapped produces 55 bytes", async function () {
        const targetAddress = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
        const result: string = await harness.read.encodeTransferWrapped([
            0, 500n, 10n, targetAddress, 2,
        ]);

        assert.equal(result.length, 2 + 55 * 2);
    });

    // ──────────────────────────────────────────────
    // encodeTransferPayload
    // ──────────────────────────────────────────────

    it("encodeTransferPayload produces 54 bytes", async function () {
        const targetAddress = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
        const result: string = await harness.read.encodeTransferPayload([
            0, 100n, 0n, targetAddress, 1,
        ]);

        // 54 bytes payload
        assert.equal(result.length, 2 + 54 * 2);
    });

    it("encodeTransferPayload encodes nonce as u32 LE at offset 0", async function () {
        const targetAddress = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
        const result: string = await harness.read.encodeTransferPayload([
            0x12345678, 100n, 0n, targetAddress, 1,
        ]);

        const bytes = Buffer.from(result.slice(2), "hex");
        assert.equal(bytes.readUInt32LE(0), 0x12345678);
    });

    it("encodeTransferPayload encodes large amount correctly", async function () {
        const targetAddress = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
        const largeAmount = 18446744073709551615n; // u64 max
        const result: string = await harness.read.encodeTransferPayload([
            0, largeAmount, 0n, targetAddress, 1,
        ]);

        const bytes = Buffer.from(result.slice(2), "hex");
        assert.equal(bytes.readBigUInt64LE(4), largeAmount);
    });

    it("encodeTransferPayload encodes targetChain as u16 LE at offset 52", async function () {
        const targetAddress = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
        const result: string = await harness.read.encodeTransferPayload([
            0, 100n, 0n, targetAddress, 0x0102,
        ]);

        const bytes = Buffer.from(result.slice(2), "hex");
        assert.equal(bytes.readUInt16LE(52), 0x0102);
    });
});
