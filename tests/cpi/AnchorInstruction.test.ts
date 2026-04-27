import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { sha256 } from "viem";

/**
 * Golden-vector tests for AnchorInstruction.
 *
 * - discriminator("swap") == 0xf8c69e91e17587c8  (Meteora DAMM v1 published)
 * - discriminator("deposit_reserve_liquidity_and_obligation_collateral")
 *     == Kamino DEPOSIT_DISC (0x81c70402de271a2e) per
 *        rome-showcase feat-m2c-drift-adapter branch
 * - discriminator("place_perp_order")
 *     == Drift PLACE_PERP_ORDER_DISC (0x45a15dca787e4cb9) per
 *        rome-showcase feat-m2c-drift-adapter branch
 *
 * Each is also cross-checked against `sha256("global:" + name)[..8]`
 * computed in ts with viem.
 */

describe("AnchorInstruction", () => {
    let wrapper: any;

    before(async () => {
        const { viem } = await hardhat.network.connect();
        wrapper = await viem.deployContract("AnchorInstructionWrapper", []);
    });

    function anchorDisc(name: string): `0x${string}` {
        const hash = sha256(new TextEncoder().encode("global:" + name));
        return hash.slice(0, 18) as `0x${string}`;  // 0x + 16 hex chars = 8 bytes
    }

    // ──────────────────────────────────────────────────────────────────
    // discriminator()
    // ──────────────────────────────────────────────────────────────────

    it("discriminator('swap') matches published Meteora DAMM v1 value", async () => {
        const onchain = await wrapper.read.discriminator(["swap"]);
        assert.equal(
            (onchain as string).toLowerCase(),
            "0xf8c69e91e17587c8",
        );
    });

    it("discriminator for Kamino deposit matches live adapter constant", async () => {
        const onchain = await wrapper.read.discriminator([
            "deposit_reserve_liquidity_and_obligation_collateral",
        ]);
        assert.equal(
            (onchain as string).toLowerCase(),
            "0x81c70402de271a2e",
        );
    });

    it("discriminator for Drift place_perp_order matches live adapter constant", async () => {
        const onchain = await wrapper.read.discriminator(["place_perp_order"]);
        assert.equal(
            (onchain as string).toLowerCase(),
            "0x45a15dca787e4cb9",
        );
    });

    it("discriminator matches viem sha256 derivation for arbitrary names", async () => {
        for (const name of ["foo", "bar_baz", "initialize_user", "withdraw"]) {
            const onchain = await wrapper.read.discriminator([name]);
            const expected = anchorDisc(name);
            assert.equal(
                (onchain as string).toLowerCase(),
                expected.toLowerCase(),
                `discriminator('${name}') mismatch`,
            );
        }
    });

    // ──────────────────────────────────────────────────────────────────
    // withDisc
    // ──────────────────────────────────────────────────────────────────

    it("withDisc(empty) returns 8-byte disc alone", async () => {
        const disc = "0xf8c69e91e17587c8" as `0x${string}`;
        const out: string = (await wrapper.read.withDiscEmpty([disc])) as string;
        assert.equal(out.toLowerCase(), disc.toLowerCase());
    });

    it("withDisc(args) prefixes the 8-byte disc to the payload", async () => {
        const disc = "0xf8c69e91e17587c8" as `0x${string}`;
        const args = "0xdeadbeef" as `0x${string}`;
        const out: string = (await wrapper.read.withDiscArgs([disc, args])) as string;
        assert.equal(
            out.toLowerCase(),
            (disc + "deadbeef").toLowerCase().replace("0x0x", "0x"),
        );
    });

    // ──────────────────────────────────────────────────────────────────
    // optionNone / optionSome
    // ──────────────────────────────────────────────────────────────────

    it("optionNone returns single 0x00 tag byte", async () => {
        const out: string = (await wrapper.read.optionNone()) as string;
        assert.equal(out.toLowerCase(), "0x00");
    });

    it("optionSome prefixes 0x01 tag", async () => {
        const value = "0x01020304" as `0x${string}`;
        const out: string = (await wrapper.read.optionSome([value])) as string;
        assert.equal(out.toLowerCase(), "0x0101020304");
    });

    // ──────────────────────────────────────────────────────────────────
    // LE primitives — round-trip
    // ──────────────────────────────────────────────────────────────────

    function toLeHex(n: bigint, bytes: number): `0x${string}` {
        let out = "";
        let v = n;
        // Handle signed numbers with two's-complement wrap
        if (v < 0n) {
            const mask = (1n << BigInt(bytes * 8)) - 1n;
            v = ((v % (1n << BigInt(bytes * 8))) + (1n << BigInt(bytes * 8))) & mask;
        }
        for (let i = 0; i < bytes; i++) {
            const b = Number((v >> BigInt(i * 8)) & 0xffn);
            out += b.toString(16).padStart(2, "0");
        }
        return ("0x" + out) as `0x${string}`;
    }

    it("u16le round-trip", async () => {
        for (const n of [0, 1, 255, 256, 0x1234, 0xffff]) {
            const expected = toLeHex(BigInt(n), 2);
            const got: string = (await wrapper.read.u16le([BigInt(n)])) as string;
            assert.equal(got.toLowerCase(), expected.toLowerCase(), `u16le(${n})`);
        }
    });

    it("u32le round-trip", async () => {
        for (const n of [0, 1, 0x12345678, 0xffffffff]) {
            const expected = toLeHex(BigInt(n), 4);
            const got: string = (await wrapper.read.u32le([BigInt(n)])) as string;
            assert.equal(got.toLowerCase(), expected.toLowerCase(), `u32le(${n})`);
        }
    });

    it("i32le round-trip for positive and negative", async () => {
        for (const n of [0, 1, -1, 0x7fffffff, -0x80000000]) {
            const expected = toLeHex(BigInt(n), 4);
            const got: string = (await wrapper.read.i32le([BigInt(n)])) as string;
            assert.equal(got.toLowerCase(), expected.toLowerCase(), `i32le(${n})`);
        }
    });

    it("u64le delegates to Convert.u64le", async () => {
        for (const n of [0n, 1n, 0x0102030405060708n, (1n << 64n) - 1n]) {
            const expected = toLeHex(n, 8);
            const got: string = (await wrapper.read.u64le([n])) as string;
            assert.equal(got.toLowerCase(), expected.toLowerCase(), `u64le(${n})`);
        }
    });

    it("i64le round-trip", async () => {
        const cases: bigint[] = [0n, 1n, -1n, (1n << 63n) - 1n, -(1n << 63n)];
        for (const n of cases) {
            const expected = toLeHex(n, 8);
            const got: string = (await wrapper.read.i64le([n])) as string;
            assert.equal(got.toLowerCase(), expected.toLowerCase(), `i64le(${n})`);
        }
    });

    it("boolle returns 0x00 / 0x01", async () => {
        const gotFalse: string = (await wrapper.read.boolle([false])) as string;
        const gotTrue: string = (await wrapper.read.boolle([true])) as string;
        assert.equal(gotFalse.toLowerCase(), "0x00");
        assert.equal(gotTrue.toLowerCase(), "0x01");
    });
});
