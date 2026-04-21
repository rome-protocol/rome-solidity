import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { buildSwitchboardAccount } from "./helpers/mockSwitchboard.js";

describe("SwitchboardParser", function () {
    let parser: any;

    before(async function () {
        const { viem } = await hardhat.network.connect();
        parser = await viem.deployContract("SwitchboardParserHarness", []);
    });

    // ──────────────────────────────────────────────
    // Happy-path parsing
    // ──────────────────────────────────────────────

    it("parses SOL/USD correctly (mantissa=15000000000, scale=8)", async function () {
        const mockData = buildSwitchboardAccount({
            mantissa: 15000000000n, // $150.00 with scale=8
            scale: 8,
            timestamp: 1711900800,
            slot: 12345n,
        });

        const [mantissa, scale, timestamp, slot] = await parser.read.parse([
            mockData,
        ]);

        assert.equal(mantissa, 15000000000n);
        assert.equal(scale, 8);
        assert.equal(timestamp, 1711900800n);
        assert.equal(slot, 12345n);
    });

    it("parses BTC/USD with large mantissa", async function () {
        const mockData = buildSwitchboardAccount({
            mantissa: 6543210000000000n, // $65432.10 with scale=11
            scale: 11,
            timestamp: 1711900900,
        });

        const [mantissa, scale] = await parser.read.parse([mockData]);

        assert.equal(mantissa, 6543210000000000n);
        assert.equal(scale, 11);
    });

    it("handles zero scale", async function () {
        const mockData = buildSwitchboardAccount({
            mantissa: 150n,
            scale: 0,
            timestamp: 1711901000,
        });

        const [mantissa, scale] = await parser.read.parse([mockData]);

        assert.equal(mantissa, 150n);
        assert.equal(scale, 0);
    });

    it("handles negative mantissa", async function () {
        const mockData = buildSwitchboardAccount({
            mantissa: -100n,
            scale: 8,
            timestamp: 1711901100,
        });

        const [mantissa] = await parser.read.parse([mockData]);
        assert.equal(mantissa, -100n);
    });

    // ──────────────────────────────────────────────
    // Error cases
    // ──────────────────────────────────────────────

    it("reverts on invalid discriminator", async function () {
        const mockData = buildSwitchboardAccount({
            discriminator: 0xdeadbeefdeadbeefn,
            mantissa: 100n,
            scale: 8,
            timestamp: 1711901200,
        });

        await assert.rejects(
            async () => parser.read.parse([mockData]),
            (err: any) => {
                assert.ok(
                    err.message.includes("InvalidSwitchboardAccount") ||
                        err.message.includes("revert"),
                    `Expected InvalidSwitchboardAccount, got: ${err.message}`,
                );
                return true;
            },
        );
    });

    it("reverts on data too short", async function () {
        const shortData = "0x" + "00".repeat(100);

        await assert.rejects(
            async () => parser.read.parse([shortData as `0x${string}`]),
            (err: any) => {
                assert.ok(
                    err.message.includes("SwitchboardDataTooShort") ||
                        err.message.includes("revert"),
                    `Expected SwitchboardDataTooShort, got: ${err.message}`,
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

    // ──────────────────────────────────────────────
    // Fuzz: offset stability
    // ──────────────────────────────────────────────

    describe("fuzz: offset stability", function () {
        it("either parses or reverts for 50 randomly mutated accounts", async function () {
            const knownErrors = [
                "InvalidSwitchboardAccount",
                "SwitchboardDataTooShort",
                "revert",
            ];

            for (let i = 0; i < 50; i++) {
                // NOTE: use whatever arguments the existing mock helper takes.
                // Base call below may need adjustment — match an existing test
                // in this file that builds a valid account. Typical args:
                // mantissa, scale, timestamp. Confirm by reading the helper.
                const base = buildSwitchboardAccount({
                    mantissa: 12345n,
                    scale: 6,
                    timestamp: 1711900800,
                });
                const baseBuf = Buffer.from(base.slice(2), "hex");
                const mutated = Buffer.from(baseBuf);

                const numMutations = 1 + (i % 8);
                for (let j = 0; j < numMutations; j++) {
                    const offset = 8 + Math.floor(Math.random() * (mutated.length - 8));
                    mutated[offset] = Math.floor(Math.random() * 256);
                }

                const mutatedHex = ("0x" + mutated.toString("hex")) as `0x${string}`;

                try {
                    await parser.read.parse([mutatedHex]);
                } catch (err: any) {
                    const msg = err?.message ?? String(err);
                    const matched = knownErrors.some((e) => msg.includes(e));
                    if (!matched) {
                        throw new Error(`Unknown revert at iteration ${i}: ${msg}`);
                    }
                }
            }
        });
    });
});
