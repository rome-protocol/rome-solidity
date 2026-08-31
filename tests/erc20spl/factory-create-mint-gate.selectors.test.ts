import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, stringToBytes } from "viem";

// Regression lock for the ERC20SPLFactory leg of the rome-evm DELEGATECALL
// identity gate migration (Halborn #511) — companion to
// tests/erc20spl/delegatecall-gate.selectors.test.ts, which locks the
// erc20spl.sol / erc20spl_cached.sol / RomeBridgeWithdraw.sol call sites.
//
// create_token_mint() was the one gate-migration site where a plain
// delegatecall->call swap is not gate-safe: HelperProgram.create_and_init_mint
// derives both the salt-derived mint PDA and its rent payer from
// context.caller, and a direct CALL from the factory rebinds context.caller
// to the factory itself (SputnikVM CALL semantics: callee.caller =
// caller-frame.address — see evm/runtime/src/eval/system.rs), corrupting
// the address get_current_mint(user) predicts. The fix removes the on-chain
// create step from the factory entirely; the create step is now a
// user-direct HelperProgram.create_and_init_mint call the factory never
// mediates.
//
// This asserts that fix at the bytecode level: ERC20SPLFactory's deployed
// bytecode must no longer reference create_and_init_mint's selector at all
// (delegatecall OR call) — the strongest available network-independent
// check, since actually exercising the gate needs a live chain running the
// gated program build (not available in this repo — see
// tests/erc20spl/delegatecall-gate.integration.ts).
describe("ERC20SPLFactory — create_token_mint gate migration (Halborn #511)", () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const artifactPath = path.join(
        __dirname, "..", "..", "artifacts", "contracts", "erc20spl",
        "erc20spl_factory.sol", "ERC20SPLFactory.json",
    );

    function selectorOf(signature: string): string {
        return keccak256(stringToBytes(signature)).slice(2, 10);
    }

    it("create_and_init_mint(uint8,bytes32,bool,bytes32,bytes32) selector = 0x20972d0f", () => {
        // Locks the selector this test greps for against the canonical
        // signature — if this drifts, the bytecode-absence check below
        // would silently stop meaning anything.
        assert.equal(selectorOf("create_and_init_mint(uint8,bytes32,bool,bytes32,bytes32)"), "20972d0f");
    });

    it("ERC20SPLFactory's deployed bytecode never references create_and_init_mint's selector", () => {
        const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
        const deployedBytecode: string = artifact.deployedBytecode.toLowerCase();
        assert.ok(
            !deployedBytecode.includes("20972d0f"),
            "ERC20SPLFactory must not call HelperProgram.create_and_init_mint " +
            "(delegatecall or direct call) — the create step must be user-direct, " +
            "not factory-mediated. See create_token_mint()'s NatSpec.",
        );
    });

    it("create_token_mint() is still declared in the ABI (present, but as a revert-only shim)", () => {
        const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
        const entry = artifact.abi.find(
            (item: any) => item.type === "function" && item.name === "create_token_mint",
        );
        assert.ok(entry, "create_token_mint must stay in the ABI (selector-stable revert, not deleted)");
        assert.equal(entry.inputs.length, 0);

        const errorEntry = artifact.abi.find(
            (item: any) => item.type === "error" && item.name === "CreateTokenMintMovedOffFactory",
        );
        assert.ok(errorEntry, "CreateTokenMintMovedOffFactory custom error must be declared");
    });
});
