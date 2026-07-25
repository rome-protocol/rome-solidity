import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
