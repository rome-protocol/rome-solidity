import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// `escrow_ata` names a real, live escrow account only on the two wrappers
// whose `_transfer` path actually routes a contract holder's SPL through
// it — `SPL_ERC20` (this file) and `SPL_ERC20_cached` (its independent
// copy in erc20spl_cached.sol). `SPL_ERC20_Token2022Hooked` never reaches
// that ledger at all: its `transfer`/`transferFrom` both revert before
// `_transfer` can run (see its `balanceOf` doc comment), so a public
// `escrow_ata` getter there would name an account that stays permanently
// empty — a footgun for any integrator reading the ABI, and an extra
// deploy-time precompile call paid for nothing. This test pins the ABI
// surface directly off the compiled artifacts so that asymmetry cannot
// regress silently.
function abiOf(artifactPath: string) {
    return JSON.parse(readFileSync(artifactPath, "utf8")).abi as any[];
}

function hasFunction(abi: any[], name: string): boolean {
    return abi.some((entry) => entry.type === "function" && entry.name === name);
}

describe("escrow_ata — ABI surface matches which wrappers actually escrow", () => {
    it("SPL_ERC20 (legacy track, escrows contract holders) declares escrow_ata", () => {
        const abi = abiOf("artifacts/contracts/erc20spl/erc20spl.sol/SPL_ERC20.json");
        assert.ok(hasFunction(abi, "escrow_ata"), "SPL_ERC20 escrows contract holders and must expose escrow_ata");
    });

    it("SPL_ERC20_cached (cached track, escrows contract holders) declares escrow_ata", () => {
        const abi = abiOf("artifacts/contracts/erc20spl/erc20spl_cached.sol/SPL_ERC20_cached.json");
        assert.ok(hasFunction(abi, "escrow_ata"), "SPL_ERC20_cached escrows contract holders and must expose escrow_ata");
    });

    it("SPL_ERC20_Token2022Hooked (never escrows) does NOT declare escrow_ata", () => {
        const abi = abiOf("artifacts/contracts/erc20spl/erc20spl_token2022_hooked.sol/SPL_ERC20_Token2022Hooked.json");
        assert.equal(
            hasFunction(abi, "escrow_ata"),
            false,
            "the hooked wrapper's transfer/transferFrom both revert before _transfer can run, so it must not publish a getter naming an account that is always empty",
        );
    });
});
