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
    it("both raw-pubkey callers pass a program resolved from the mint", () => {
        for (const f of ["erc20spl/erc20spl.sol", "bridge/RomeBridgeWithdraw.sol"]) {
            const s = src(f);
            assert.match(
                s,
                /ataForKeyWithProgram\(/,
                `${f} must derive with an explicit token program`,
            );
            assert.match(
                s,
                /mint_info\(/,
                `${f} must take that program from the mint, not assume it`,
            );
            assert.doesNotMatch(
                s,
                /UserPda\.ataForKey\(/,
                `${f} must not use the legacy-only derivation`,
            );
        }
    });

    it("the legacy-only helpers say so, so they are not reached for by mistake", () => {
        const s = src("cpi/UserPda.sol");
        // ataForKey and atas both bake in SPL_TOKEN_PROGRAM.
        assert.match(s, /Legacy SPL Token only — the token program is baked/);
        assert.match(s, /Legacy SPL Token only, same reason as `ataForKey`/);
    });

    it("ata() is documented as already program-aware, so nobody 'fixes' it", () => {
        // It delegates to HelperProgram.ata, which resolves the program from the
        // mint's owner in Rust. An earlier comment claimed the opposite.
        const s = src("cpi/UserPda.sol");
        assert.match(s, /correct for Token-2022 as well/);
        assert.doesNotMatch(s, /assuming the\s+\/\/\/ classic SPL Token program/);
    });
});
