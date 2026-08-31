import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256, stringToBytes } from "viem";

// Selector hex locks for the call sites migrated off DELEGATECALL to a
// direct CALL, per the rome-evm DELEGATECALL identity gate
// (owner_authenticated := context.address == code_address, true only for
// direct CALL/STATICCALL). If a signature here drifts from the on-chain
// dispatcher's const, these selectors silently stop matching and every
// migrated call reverts with an opaque precompile error instead of a
// selector mismatch at compile time.
//
// Companion to tests/erc20spl/cached.selectors.test.ts (transfer/approve/
// mint, already locked there) — this file locks the additional selectors
// this migration newly routes through: the addr-keyed delegate transfer on
// HelperProgram, and the raw-ATA delegate transfer used by bridgeOutToSolana
// on both erc20spl.sol and RomeBridgeWithdraw.sol.

function selectorOf(signature: string): `0x${string}` {
    return keccak256(stringToBytes(signature)).slice(0, 10) as `0x${string}`;
}

describe("Delegatecall-gate migration — selectors used by the direct-call paths", () => {
    it("HelperProgram.transfer_spl(address,address,uint64,bytes32) = 0xe479df56", () => {
        // Sender-path `transfer()` on erc20spl.sol now targets this
        // addr-keyed delegate overload directly (from == msg.sender),
        // instead of the owner-only 3-arg overload via delegatecall.
        assert.equal(
            selectorOf("transfer_spl(address,address,uint64,bytes32)"),
            "0xe479df56",
        );
    });

    it("HelperProgram.transfer_spl(bytes32,bytes32,uint64,bytes32) = 0x766b362a", () => {
        // Raw-ATA delegate overload — bridgeOutToSolana (erc20spl.sol AND
        // RomeBridgeWithdraw.sol) now targets this directly instead of the
        // owner-only 3-arg raw-ATA overload.
        assert.equal(
            selectorOf("transfer_spl(bytes32,bytes32,uint64,bytes32)"),
            "0x766b362a",
        );
    });

    it("HelperProgram.approve_spl(address,uint64,bytes32) = 0xabf6f675", () => {
        assert.equal(
            selectorOf("approve_spl(address,uint64,bytes32)"),
            "0xabf6f675",
        );
    });

    it("HelperProgram.approve_spl_raw_delegate(bytes32,bytes32,uint64,bytes32,uint8) = 0x7881d453", () => {
        assert.equal(
            selectorOf("approve_spl_raw_delegate(bytes32,bytes32,uint64,bytes32,uint8)"),
            "0x7881d453",
        );
    });

    it("HelperProgram.mint_spl(address,uint64,bytes32) = 0xd795522b", () => {
        assert.equal(
            selectorOf("mint_spl(address,uint64,bytes32)"),
            "0xd795522b",
        );
    });

    it("CrossProgramInvocation.invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[]) = 0xb94f3733", () => {
        assert.equal(
            selectorOf("invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])"),
            "0xb94f3733",
        );
    });
});
