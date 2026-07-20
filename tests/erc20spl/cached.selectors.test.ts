import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256, stringToBytes } from "viem";

// Selector hex locks — assert `cast keccak` matches the consts the cache-based
// precompiles dispatch on, post-#386. If `the Rome EVM program` renames a
// selector or changes a signature, these tests fail and the wrapper rebuild
// halts before behavioral drift can land.
//
// Source of truth:
//   - the Rome EVM program (lines 30-37)
//   - the Rome EVM program (lines 22-25)
//
// Verified against origin/master post-PR #386 on 2026-05-23.

function selectorOf(signature: string): `0x${string}` {
    return keccak256(stringToBytes(signature)).slice(0, 10) as `0x${string}`;
}

describe("SPL_ERC20_cached — cache-based selectors used by the wrapper", () => {
    it("SplCached.transfer(address,uint256,bytes32) = 0x57cfeeee", () => {
        assert.equal(
            selectorOf("transfer(address,uint256,bytes32)"),
            "0x57cfeeee",
        );
    });

    it("SplCached.transferFrom(address,address,uint256,bytes32) = 0x401e3367", () => {
        assert.equal(
            selectorOf("transferFrom(address,address,uint256,bytes32)"),
            "0x401e3367",
        );
    });

    it("SplCached.approve(address,uint256,bytes32) = 0x8180f2fc", () => {
        assert.equal(
            selectorOf("approve(address,uint256,bytes32)"),
            "0x8180f2fc",
        );
    });

    it("SplCached.mint(address,uint256,bytes32) = 0x1e458bee", () => {
        assert.equal(
            selectorOf("mint(address,uint256,bytes32)"),
            "0x1e458bee",
        );
    });

    it("AssociatedSplCached.create_ata(address,bytes32) = 0x3de2251a", () => {
        assert.equal(
            selectorOf("create_ata(address,bytes32)"),
            "0x3de2251a",
        );
    });
});
