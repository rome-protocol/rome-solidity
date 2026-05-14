import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_PATH = join(__dirname, "../../contracts/cpi/AccountReader.sol");
const WRAPPER_PATH = join(__dirname, "../../contracts/cpi/test/AccountReaderWrapper.sol");

/**
 * AccountReader tests.
 *
 * AccountReader wraps the `CpiProgram` precompile's account-read selectors
 * (`account_data_at` / `account_u64_at` / `account_lamports`) into typed
 * named functions. The selectors are EVM-precompile calls that only
 * dispatch on a live Rome chain — Hardhat-simulated EVM cannot reach them
 * — so functional/integration verification lives in SPL_ERC20 and oracle
 * adapter integration tests (`--network local`).
 *
 * These unit tests are source-level: file exists, surface matches contract,
 * no state, no unsafe patterns. They're enough to catch regressions in the
 * shape of the library.
 */

describe("AccountReader", () => {
    it("library file exists at contracts/cpi/AccountReader.sol", () => {
        assert.equal(existsSync(LIB_PATH), true, `expected ${LIB_PATH} to exist`);
    });

    it("test-only wrapper exists at contracts/cpi/test/AccountReaderWrapper.sol", () => {
        assert.equal(existsSync(WRAPPER_PATH), true, `expected ${WRAPPER_PATH} to exist`);
    });

    it("declares the four expected internal view functions", () => {
        const src = readFileSync(LIB_PATH, "utf8");

        // Each function: typed name, internal view, expected signature.
        const expected = [
            /function\s+lamportsOf\s*\(\s*bytes32\s+\w+\s*\)\s+internal\s+view\s+returns\s*\(\s*uint64\s*\)/,
            /function\s+readU64At\s*\(\s*bytes32\s+\w+\s*,\s*uint16\s+\w+\s*\)\s+internal\s+view\s+returns\s*\(\s*uint64\s*\)/,
            /function\s+readBytesAt\s*\(\s*bytes32\s+\w+\s*,\s*uint16\s+\w+\s*,\s*uint16\s+\w+\s*\)\s+internal\s+view\s+returns\s*\(\s*bytes\s+memory\s*\)/,
            /function\s+readBytes32At\s*\(\s*bytes32\s+\w+\s*,\s*uint16\s+\w+\s*\)\s+internal\s+view\s+returns\s*\(\s*bytes32\s*\)/,
        ];

        for (const re of expected) {
            assert.match(src, re, `missing function signature matching ${re}`);
        }
    });

    it("is a pure library (no state, no constructor, no fallback)", () => {
        const src = readFileSync(LIB_PATH, "utf8");

        assert.equal(src.includes("library AccountReader"), true,
            "AccountReader must be declared as `library AccountReader`");

        // No state variables, mappings, or storage declarations outside functions.
        // Libraries can't have state but enforce zero-style to catch refactor mistakes.
        assert.equal(/^\s*mapping\s*\(/m.test(src), false, "library must not declare mappings");
        assert.equal(/constructor\s*\(/m.test(src), false, "library must not declare a constructor");
        assert.equal(/fallback\s*\(/m.test(src), false, "library must not declare fallback");
        assert.equal(/receive\s*\(/m.test(src), false, "library must not declare receive");
    });

    it("dispatches through CpiProgram, not raw address calls", () => {
        const src = readFileSync(LIB_PATH, "utf8");

        // Each typed read must route through the pre-bound `CpiProgram`
        // constant. No raw `address(...).call(...)` or
        // `address(...).delegatecall(...)` patterns — those would bypass
        // the typed dispatch the library promises to provide.
        assert.equal(/CpiProgram\.account_lamports\s*\(/.test(src), true,
            "lamportsOf must dispatch through CpiProgram.account_lamports");
        assert.equal(/CpiProgram\.account_u64_at\s*\(/.test(src), true,
            "readU64At must dispatch through CpiProgram.account_u64_at");
        assert.equal(/CpiProgram\.account_data_at\s*\(/.test(src), true,
            "readBytesAt/readBytes32At must dispatch through CpiProgram.account_data_at");

        assert.equal(/\.call\s*\(/.test(src), false,
            "library must not use raw .call(...) — use typed CpiProgram dispatch");
        assert.equal(/\.delegatecall\s*\(/.test(src), false,
            "library must not use raw .delegatecall(...) — use typed CpiProgram dispatch");
    });

    it("wrapper exposes all four functions for tests", () => {
        const src = readFileSync(WRAPPER_PATH, "utf8");

        for (const name of ["lamportsOf", "readU64At", "readBytesAt", "readBytes32At"]) {
            assert.match(src, new RegExp(`function\\s+${name}\\s*\\(`),
                `wrapper must expose ${name}`);
        }
    });
});
