import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256, stringToBytes, toFunctionSelector } from "viem";
import { readFileSync } from "node:fs";

// mint_info selector lock, both directions.
//
// The signature is declared twice in interface.sol — once on the legacy
// HelperProgram and once on the cached SplCached — because a contract must read
// from the track it is already on. Both must dispatch on the SAME selector so
// callers write one call either way, and both must match the const the Rome EVM
// program dispatches on. A signature edit on either side fails here rather than
// silently reaching a dispatcher that no longer recognises it.

const MINT_INFO = "0xe24bf5d4";
const SIG = "mint_info(bytes32)";

function selectorOf(signature: string): `0x${string}` {
    return keccak256(stringToBytes(signature)).slice(0, 10) as `0x${string}`;
}

function abiOf(iface: string) {
    const p = `artifacts/contracts/interface.sol/${iface}.json`;
    return JSON.parse(readFileSync(p, "utf8")).abi as any[];
}

describe("mint_info — selector parity with the Rome EVM program", () => {
    it(`${SIG} = ${MINT_INFO}`, () => {
        assert.equal(selectorOf(SIG), MINT_INFO);
    });

    for (const iface of ["IHelperProgram", "ISplCached"]) {
        it(`${iface} declares it, and the compiled selector matches`, () => {
            const entry = abiOf(iface).find(
                (e) => e.type === "function" && e.name === "mint_info",
            );
            assert.ok(entry, `${iface} must declare mint_info`);
            assert.equal(toFunctionSelector(entry), MINT_INFO);
        });

        it(`${iface} returns the five fields the program encodes`, () => {
            const entry = abiOf(iface).find(
                (e) => e.type === "function" && e.name === "mint_info",
            )!;
            assert.deepEqual(
                entry.outputs.map((o: any) => `${o.type} ${o.name}`),
                [
                    "bytes32 tokenProgram",
                    "uint8 decimals",
                    "bytes32 hookProgram",
                    "uint16 feeBps",
                    "uint32 extensions",
                ],
                "field order is the program's ABI encoding order",
            );
        });

        it(`${iface}.mint_info is a view`, () => {
            const entry = abiOf(iface).find(
                (e) => e.type === "function" && e.name === "mint_info",
            )!;
            assert.equal(entry.stateMutability, "view");
        });
    }
});
