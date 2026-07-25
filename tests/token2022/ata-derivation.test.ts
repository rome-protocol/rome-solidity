import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { network } from "hardhat";

// The token program is part of the ATA seeds, so an ATA for a Token-2022 mint is
// at a DIFFERENT address than the same mint under legacy SPL Token. Deriving with
// a hardcoded legacy program — which is what ataForKey does — produced one address
// while HelperProgram.create_ata_for_key created another, so bridge-out targeted
// an account that never existed, for every Token-2022 mint including
// extension-free ones.
//
// Byte-identity of the derivation itself is NOT asserted here: it runs through
// Rome's find_program_address precompile, which hardhat does not provide (the same
// reason tests/cpi/UserPda.test.ts gates its integration cases on a live stack).
// That belongs to the funded suite. What is asserted here is the wiring, which is
// what can silently regress.

function src(p: string): string {
    return readFileSync(`contracts/${p}`, "utf8");
}

describe("ATA derivation is program-aware", () => {
    it("ataForKey resolves the token program itself — callers cannot get it wrong", () => {
        const s = src("cpi/UserPda.sol");
        // Fixed in place rather than given a sibling: a second entry point would
        // leave the wrong one reachable, and callers would have to remember which.
        assert.match(
            s,
            /function ataForKey\(bytes32 ownerKey, bytes32 mint\)\s+internal\s+view/,
            "ataForKey must be view — it reads the mint to resolve the program",
        );
        assert.match(s, /HelperProgram\.mint_info\(mint\)/);
        assert.doesNotMatch(
            s,
            /ataForKeyWithProgram/,
            "no explicit-program sibling: the one function is correct for both",
        );
    });

    it("callers just call it, and pass no program", () => {
        for (const f of ["erc20spl/erc20spl.sol", "bridge/RomeBridgeWithdraw.sol"]) {
            assert.match(src(f), /UserPda\.ataForKey\(/, `${f} derives via UserPda`);
        }
    });

    it("the batch variant is still legacy-only, and says so", () => {
        // atas bakes in SPL_TOKEN_PROGRAM. It has no caller outside its test
        // wrapper, so it is documented rather than given a per-mint resolve it
        // would pay for N times.
        assert.match(src("cpi/UserPda.sol"), /Legacy SPL Token only — unlike `ataForKey`/);
    });

    it("ata() is documented as already program-aware, so nobody 'fixes' it", () => {
        // It delegates to HelperProgram.ata, which resolves the program from the
        // mint's owner in Rust. An earlier comment claimed the opposite.
        const s = src("cpi/UserPda.sol");
        assert.match(s, /correct for Token-2022 as well/);
        assert.doesNotMatch(s, /assuming the\s+\/\/\/ classic SPL Token program/);
    });
});

// The block above reads source, and its comment said byte-identity "belongs to the
// funded suite" because hardhat has no find_program_address. That is now only half
// true: byte-identity against Solana still needs a real chain (asserted on a live
// stack in the tests repo), but the property that actually broke bridge-out is
// observable here.
//
// That property is program-dependence: an ATA's seeds include the token program,
// so resolving it from the mint has to produce a different address than resolving
// it to a hardcoded legacy program. Two mints that differ in nothing but which
// program they report must therefore derive to different addresses — and an
// implementation with the program hardcoded returns the same one for both.
describe("ATA derivation is program-aware, executed", async () => {
    const SYSTEM = "0xff00000000000000000000000000000000000007";
    const HELPER = "0xff00000000000000000000000000000000000009";

    const conn = await network.connect();
    const { viem } = conn;
    const mock = await viem.deployContract("MintInfoMock");
    const code = await (await viem.getPublicClient()).getCode({ address: mock.address });
    for (const a of [SYSTEM, HELPER]) {
        await conn.provider.request({ method: "hardhat_setCode", params: [a, code] });
    }
    const wrapper = await viem.deployContract("UserPdaWrapper");

    /// Identical mints but for byte 4, which is what the mocked mint_info reads to
    /// decide whether the mint is Token-2022 or legacy.
    function mint(legacy: boolean): `0x${string}` {
        const b = new Uint8Array(32);
        b[0] = 6;
        b[4] = legacy ? 1 : 0;
        b[31] = 0xa7;
        return `0x${Buffer.from(b).toString("hex")}` as `0x${string}`;
    }

    const owner = `0x${"11".repeat(32)}` as `0x${string}`;

    it("the same owner and mint derive different ATAs under different token programs", async () => {
        const as2022 = await wrapper.read.ataForKey([owner, mint(false)]);
        const asLegacy = await wrapper.read.ataForKey([owner, mint(true)]);
        assert.notEqual(
            as2022,
            asLegacy,
            "ataForKey must feed the mint's own program into the seeds — a hardcoded " +
                "program derives one address for both, which is the bug that made " +
                "bridge-out target an account create_ata_for_key never created",
        );
    });

    it("it is the token program that moves the address, not the mint bytes", async () => {
        // Same program, different mint: also different, so the previous assertion
        // is not just observing that the mint changed.
        const a = await wrapper.read.ataForKey([owner, mint(false)]);
        const b = new Uint8Array(32);
        b[0] = 6;
        b[31] = 0xa8;
        const other = await wrapper.read.ataForKey([owner, `0x${Buffer.from(b).toString("hex")}` as `0x${string}`]);
        assert.notEqual(a, other, "the mint is in the seeds too");
    });

    it("deriving twice is stable", async () => {
        const a = await wrapper.read.ataForKey([owner, mint(false)]);
        const b = await wrapper.read.ataForKey([owner, mint(false)]);
        assert.equal(a, b);
    });
});
