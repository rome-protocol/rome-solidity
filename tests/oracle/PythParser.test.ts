import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { buildPythV2Account } from "./helpers/mockPyth.js";

describe("PythParser", function () {
    let parser: any;

    before(async function () {
        const { viem } = await hardhat.network.connect();
        parser = await viem.deployContract("PythParserHarness", []);
    });

    // ──────────────────────────────────────────────
    // Happy-path V2 parsing
    // ──────────────────────────────────────────────

    it("parses V2 BTC/USD correctly (expo=-8)", async function () {
        const mockData = buildPythV2Account({
            price: 6543210000000n, // $65,432.10 at expo=-8
            conf: 1500000n,
            expo: -8,
            publishTime: 1711900800,
        });

        const [price, conf, expo, publishTime] = await parser.read.parse([
            mockData,
        ]);

        assert.equal(price, 6543210000000n);
        assert.equal(conf, 1500000n);
        assert.equal(expo, -8);
        assert.equal(publishTime, 1711900800n);
    });

    it("parses V2 ETH/USD correctly (expo=-8)", async function () {
        const mockData = buildPythV2Account({
            price: 300000000000n, // $3,000.00 at expo=-8
            conf: 50000000n,
            expo: -8,
            publishTime: 1711900900,
        });

        const [price, conf, expo, publishTime] = await parser.read.parse([
            mockData,
        ]);

        assert.equal(price, 300000000000n);
        assert.equal(conf, 50000000n);
        assert.equal(expo, -8);
        assert.equal(publishTime, 1711900900n);
    });

    it("parses feed with non-8 exponent (expo=-5)", async function () {
        const mockData = buildPythV2Account({
            price: 123456n, // 1.23456 at expo=-5
            conf: 100n,
            expo: -5,
            publishTime: 1711901000,
        });

        const [price, , expo] = await parser.read.parse([mockData]);

        assert.equal(price, 123456n);
        assert.equal(expo, -5);
    });

    it("parses feed with positive exponent (expo=2)", async function () {
        const mockData = buildPythV2Account({
            price: 42n, // 4200 at expo=2
            conf: 1n,
            expo: 2,
            publishTime: 1711901100,
        });

        const [price, , expo] = await parser.read.parse([mockData]);

        assert.equal(price, 42n);
        assert.equal(expo, 2);
    });

    it("handles negative price (parser returns it; adapter would revert)", async function () {
        const mockData = buildPythV2Account({
            price: -500n,
            conf: 10n,
            expo: -8,
            publishTime: 1711901200,
        });

        const [price] = await parser.read.parse([mockData]);
        assert.equal(price, -500n);
    });

    it("handles zero price", async function () {
        const mockData = buildPythV2Account({
            price: 0n,
            conf: 0n,
            expo: -8,
            publishTime: 1711901300,
        });

        const [price] = await parser.read.parse([mockData]);
        assert.equal(price, 0n);
    });

    it("handles large price values near int64 max", async function () {
        const int64Max = (1n << 63n) - 1n; // 9223372036854775807
        const mockData = buildPythV2Account({
            price: int64Max,
            conf: 0n,
            expo: -8,
            publishTime: 1711901400,
        });

        const [price] = await parser.read.parse([mockData]);
        assert.equal(price, int64Max);
    });

    it("handles large confidence values", async function () {
        const largeConf = (1n << 63n) - 1n;
        const mockData = buildPythV2Account({
            price: 100n,
            conf: largeConf,
            expo: -8,
            publishTime: 1711901500,
        });

        const [, conf] = await parser.read.parse([mockData]);
        assert.equal(conf, largeConf);
    });

    // ──────────────────────────────────────────────
    // Error cases
    // ──────────────────────────────────────────────

    it("reverts on unknown version (version=3)", async function () {
        const mockData = buildPythV2Account({
            version: 3,
            price: 100n,
            conf: 10n,
            expo: -8,
            publishTime: 1711901600,
        });

        await assert.rejects(
            async () => parser.read.parse([mockData]),
            (err: any) => {
                // Check for UnsupportedPythVersion custom error
                assert.ok(
                    err.message.includes("UnsupportedPythVersion") ||
                        err.message.includes("revert"),
                    `Expected UnsupportedPythVersion, got: ${err.message}`,
                );
                return true;
            },
        );
    });

    it("reverts on invalid magic number", async function () {
        const mockData = buildPythV2Account({
            magic: 0xdeadbeef,
            price: 100n,
            conf: 10n,
            expo: -8,
            publishTime: 1711901700,
        });

        await assert.rejects(
            async () => parser.read.parse([mockData]),
            (err: any) => {
                assert.ok(
                    err.message.includes("InvalidPythAccount") ||
                        err.message.includes("revert"),
                    `Expected InvalidPythAccount, got: ${err.message}`,
                );
                return true;
            },
        );
    });

    it("reverts on data too short (< 48 bytes)", async function () {
        const shortData = "0x" + "00".repeat(32);

        await assert.rejects(
            async () => parser.read.parse([shortData as `0x${string}`]),
            (err: any) => {
                assert.ok(
                    err.message.includes("Data too short") ||
                        err.message.includes("revert"),
                    `Expected Data too short, got: ${err.message}`,
                );
                return true;
            },
        );
    });

    it("reverts on V2 data too short (>= 48 but < 240 bytes)", async function () {
        // Valid magic and version but not enough bytes for V2 fields
        const buf = new Uint8Array(100);
        // Write magic LE
        buf[0] = 0xd4;
        buf[1] = 0xc3;
        buf[2] = 0xb2;
        buf[3] = 0xa1;
        // Write version 2 LE
        buf[4] = 0x02;

        const hex =
            "0x" +
            Array.from(buf)
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("");

        await assert.rejects(
            async () => parser.read.parse([hex as `0x${string}`]),
            (err: any) => {
                assert.ok(
                    err.message.includes("V2 data too short") ||
                        err.message.includes("revert"),
                    `Expected V2 data too short, got: ${err.message}`,
                );
                return true;
            },
        );
    });

    it("reverts on version 0", async function () {
        const mockData = buildPythV2Account({
            version: 0,
            price: 100n,
            conf: 10n,
            expo: -8,
            publishTime: 1711901800,
        });

        await assert.rejects(async () => parser.read.parse([mockData]));
    });

    it("reverts on version 1", async function () {
        const mockData = buildPythV2Account({
            version: 1,
            price: 100n,
            conf: 10n,
            expo: -8,
            publishTime: 1711901900,
        });

        await assert.rejects(async () => parser.read.parse([mockData]));
    });
});
