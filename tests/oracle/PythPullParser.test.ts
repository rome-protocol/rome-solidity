import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { buildPythPullAccount } from "./helpers/mockPythPull.js";

describe("PythPullParser", function () {
    let parser: any;

    before(async function () {
        const { viem } = await hardhat.network.connect();
        parser = await viem.deployContract("PythPullParserHarness", []);
    });

    // ──────────────────────────────────────────────
    // Happy-path PriceUpdateV2 parsing
    // ──────────────────────────────────────────────

    it("parses SOL/USD correctly (expo=-8)", async function () {
        const mockData = buildPythPullAccount({
            price: 15000000000n, // $150.00 at expo=-8
            conf: 500000n,
            expo: -8,
            publishTime: 1711900800,
            emaPrice: 14900000000n,
            emaConf: 600000n,
        });

        const [price, conf, expo, publishTime, emaPrice, emaConf] =
            await parser.read.parse([mockData]);

        assert.equal(price, 15000000000n);
        assert.equal(conf, 500000n);
        assert.equal(expo, -8);
        assert.equal(publishTime, 1711900800n);
        assert.equal(emaPrice, 14900000000n);
        assert.equal(emaConf, 600000n);
    });

    it("parses BTC/USD correctly (expo=-8)", async function () {
        const mockData = buildPythPullAccount({
            price: 6543210000000n, // $65,432.10 at expo=-8
            conf: 1500000n,
            expo: -8,
            publishTime: 1711900900,
        });

        const [price, conf, expo, publishTime] = await parser.read.parse([
            mockData,
        ]);

        assert.equal(price, 6543210000000n);
        assert.equal(conf, 1500000n);
        assert.equal(expo, -8);
        assert.equal(publishTime, 1711900900n);
    });

    it("parses feed with non-8 exponent (expo=-5)", async function () {
        const mockData = buildPythPullAccount({
            price: 123456n,
            conf: 100n,
            expo: -5,
            publishTime: 1711901000,
        });

        const [price, , expo] = await parser.read.parse([mockData]);

        assert.equal(price, 123456n);
        assert.equal(expo, -5);
    });

    it("parses feed with positive exponent (expo=2)", async function () {
        const mockData = buildPythPullAccount({
            price: 42n,
            conf: 1n,
            expo: 2,
            publishTime: 1711901100,
        });

        const [price, , expo] = await parser.read.parse([mockData]);

        assert.equal(price, 42n);
        assert.equal(expo, 2);
    });

    it("handles negative price", async function () {
        const mockData = buildPythPullAccount({
            price: -500n,
            conf: 10n,
            expo: -8,
            publishTime: 1711901200,
        });

        const [price] = await parser.read.parse([mockData]);
        assert.equal(price, -500n);
    });

    it("handles zero price", async function () {
        const mockData = buildPythPullAccount({
            price: 0n,
            conf: 0n,
            expo: -8,
            publishTime: 1711901300,
        });

        const [price] = await parser.read.parse([mockData]);
        assert.equal(price, 0n);
    });

    it("handles large price values near int64 max", async function () {
        const int64Max = (1n << 63n) - 1n;
        const mockData = buildPythPullAccount({
            price: int64Max,
            conf: 0n,
            expo: -8,
            publishTime: 1711901400,
        });

        const [price] = await parser.read.parse([mockData]);
        assert.equal(price, int64Max);
    });

    it("parses EMA fields correctly", async function () {
        const mockData = buildPythPullAccount({
            price: 15000000000n,
            conf: 500000n,
            expo: -8,
            publishTime: 1711901500,
            emaPrice: 14800000000n,
            emaConf: 700000n,
        });

        const [, , , , emaPrice, emaConf] = await parser.read.parse([mockData]);

        assert.equal(emaPrice, 14800000000n);
        assert.equal(emaConf, 700000n);
    });

    // ──────────────────────────────────────────────
    // Error cases
    // ──────────────────────────────────────────────

    it("reverts on invalid discriminator", async function () {
        const mockData = buildPythPullAccount({
            discriminator: 0xdeadbeefdeadbeefn,
            price: 100n,
            conf: 10n,
            expo: -8,
            publishTime: 1711901600,
        });

        await assert.rejects(
            async () => parser.read.parse([mockData]),
            (err: any) => {
                assert.ok(
                    err.message.includes("InvalidPythPullAccount") ||
                        err.message.includes("revert"),
                    `Expected InvalidPythPullAccount, got: ${err.message}`,
                );
                return true;
            },
        );
    });

    it("reverts on data too short (< 134 bytes)", async function () {
        const shortData = "0x" + "00".repeat(100);

        await assert.rejects(
            async () => parser.read.parse([shortData as `0x${string}`]),
            (err: any) => {
                assert.ok(
                    err.message.includes("PythPullDataTooShort") ||
                        err.message.includes("revert"),
                    `Expected PythPullDataTooShort, got: ${err.message}`,
                );
                return true;
            },
        );
    });

    it("reverts on empty data", async function () {
        await assert.rejects(
            async () => parser.read.parse(["0x" as `0x${string}`]),
        );
    });
});
