import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";

// Selector parity check: the Solidity interfaces in contracts/interface.sol
// must match the selector bytes hard-coded in rome-evm-private's
// non_evm/{unwrap_spl_to_gas,wrap_gas_to_spl}.rs. These are the first 4
// bytes of keccak256(signature).
//
// Source of truth for the selectors: the Rust program's UNWRAP_SPL_TO_GAS_ID
// and WRAP_GAS_TO_SPL_ID constants. Changes to either side must be mirrored.

describe("wrap/unwrap precompile selectors", function () {
    it("unwrap_spl_to_gas(uint256) selector matches precompile constant", function () {
        const sig = "unwrap_spl_to_gas(uint256)";
        const hash = keccak256(toBytes(sig));
        const selector = hash.slice(0, 10); // "0x" + 8 hex
        assert.equal(
            selector,
            "0x1e34b809",
            "selector must equal UNWRAP_SPL_TO_GAS_ID in rome-evm-private"
        );
    });

    it("wrap_gas_to_spl(uint256) selector matches precompile constant", function () {
        const sig = "wrap_gas_to_spl(uint256)";
        const hash = keccak256(toBytes(sig));
        const selector = hash.slice(0, 10);
        assert.equal(
            selector,
            "0x79a25e80",
            "selector must equal WRAP_GAS_TO_SPL_ID in rome-evm-private"
        );
    });

    it("unwrap precompile address is 0x42..17", function () {
        const addr = "0x4200000000000000000000000000000000000017";
        assert.equal(addr.length, 42);
        assert.equal(addr.slice(0, 4).toLowerCase(), "0x42");
        assert.equal(addr.slice(-2), "17");
    });

    it("wrap precompile address is 0x42..18", function () {
        const addr = "0x4200000000000000000000000000000000000018";
        assert.equal(addr.length, 42);
        assert.equal(addr.slice(0, 4).toLowerCase(), "0x42");
        assert.equal(addr.slice(-2), "18");
    });
});
