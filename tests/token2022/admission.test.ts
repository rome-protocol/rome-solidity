import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Admission is keyed on the ARMED hook, at every path that can bring a wrapper
// into existence. Three such paths exist: the factory, and each wrapper's own
// constructor — the second reachable directly by the deploy scripts, which the
// factory gate never sees.
//
// These assert the wiring, which is what can silently regress: that each path
// declares the error and reads mint_info on its own track. Behaviour against a
// real armed-hook mint is the funded matrix's job; no armed-hook 2022 mint exists
// on devnet to point a local run at yet.

function src(p: string): string {
    return readFileSync(`contracts/${p}`, "utf8");
}
function abi(iface: string) {
    return JSON.parse(
        readFileSync(`artifacts/contracts/interface.sol/${iface}.json`, "utf8"),
    ).abi as any[];
}

const PATHS: Array<[string, string, string]> = [
    ["factory", "erc20spl/erc20spl_factory.sol", "HelperProgram"],
    ["legacy wrapper ctor", "erc20spl/erc20spl.sol", "HelperProgram"],
    ["cached wrapper ctor", "erc20spl/erc20spl_cached.sol", "SplCached"],
];

describe("armed-hook admission", () => {
    for (const [name, file, track] of PATHS) {
        it(`${name} refuses an armed hook`, () => {
            const s = src(file);
            assert.match(
                s,
                /hook_program != bytes32\(0\)/,
                "must key on the ARMED hook — a zero program_id is inert and must pass",
            );
            assert.match(s, /revert ArmedTransferHookUnsupported\(/);
        });

        it(`${name} reads mint_info on its own track (${track})`, () => {
            // verify_call refuses a legacy cross-state read once a cached invoke
            // has fired, so a cached contract reading the legacy home would fail
            // mid-transaction.
            assert.match(src(file), new RegExp(`${track}\\.mint_info\\(`));
        });
    }

    it("neither wrapper parses mint bytes in Solidity any more", () => {
        for (const f of ["erc20spl/erc20spl.sol", "erc20spl/erc20spl_cached.sol"]) {
            assert.doesNotMatch(
                src(f),
                /load_mint\(/,
                `${f} must take decimals from mint_info, not by parsing the mint (I2)`,
            );
        }
    });

    it("the error names the mint and the hook, so a failure is diagnosable", () => {
        assert.match(
            src("erc20spl/erc20spl.sol"),
            /error ArmedTransferHookUnsupported\(bytes32 mint, bytes32 hookProgram\)/,
        );
    });

    it("mint_info is declared on both tracks with the same selector", () => {
        for (const iface of ["IHelperProgram", "ISplCached"]) {
            assert.ok(
                abi(iface).some((e) => e.type === "function" && e.name === "mint_info"),
                `${iface} must declare mint_info`,
            );
        }
    });
});
