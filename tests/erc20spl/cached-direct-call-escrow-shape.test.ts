import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import hardhat from "hardhat";

/// FIND-003 (#511) structural regression suite for the CACHED wrapper —
/// same shape as direct-call-escrow-shape.test.ts (SPL_ERC20), tied 1:1 to
/// the real `contracts/erc20spl/erc20spl_cached.sol` source and compiled
/// artifact. SPL_ERC20_cached's constructor calls the live SplCached
/// precompile (mint_info), so it can't be deployed on hardhat-network
/// either — same constraint as the legacy wrapper, same substitute:
/// source-tied structural assertions instead of a live deploy.
describe("SPL_ERC20_cached dispatch shape (#511 gate) — structural, source-of-truth is the file itself", function () {
    const srcPath = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..", "..", "contracts", "erc20spl", "erc20spl_cached.sol"
    );
    const src = readFileSync(srcPath, "utf8");

    function bodyOf(fnSignatureStart: string): string {
        const start = src.indexOf(fnSignatureStart);
        assert.ok(start >= 0, `function not found: ${fnSignatureStart}`);
        const nextFn = src.indexOf("\n    function ", start + fnSignatureStart.length);
        const closeBrace = src.indexOf("\n    }", start + fnSignatureStart.length);
        const end = closeBrace === -1 ? nextFn : (nextFn === -1 ? closeBrace : Math.min(nextFn, closeBrace));
        return end === -1 ? src.slice(start) : src.slice(start, end);
    }

    it("mint_to no longer exists in source", function () {
        assert.ok(!/function mint_to\(/.test(src), "mint_to must be deleted (#511 change 5 / scope §6.1, cached track)");
    });

    it("mint_to is absent from the compiled ABI", async function () {
        const hre: any = hardhat;
        const artifact = await hre.artifacts.readArtifact("SPL_ERC20_cached");
        const hasMintTo = artifact.abi.some((entry: any) => entry.type === "function" && entry.name === "mint_to");
        assert.equal(hasMintTo, false);
    });

    it("approve() never touches SplCached — allowance is pure EVM now", function () {
        const body = bodyOf("function approve(address spender, uint256 value)");
        assert.ok(!body.includes("SplCached"), "approve() must not encode a call to SplCached (#511 change 2)");
        assert.ok(!body.includes(".delegatecall(") && !body.includes(".call("),
            "approve() must not touch a precompile at all — it's pure EVM storage now");
    });

    it("allowance() never touches SplCached's approve/mint state — allowance is pure EVM now", function () {
        const body = bodyOf("function allowance(address owner, address spender)");
        assert.ok(/return _allowances\[owner\]\[spender\]/.test(body));
        assert.ok(!body.includes(".delegatecall(") && !body.includes(".call("));
    });

    it("approve() writes the EVM allowance mapping directly", function () {
        const body = bodyOf("function approve(address spender, uint256 value)");
        assert.ok(/_allowances\[msg\.sender\]\[spender\]\s*=\s*value/.test(body));
        assert.ok(/emit Approval\(msg\.sender, spender, value\)/.test(body));
    });

    it("transferFrom() checks and decrements the EVM allowance mapping", function () {
        const body = bodyOf("function transferFrom(address from, address to, uint256 value)");
        assert.ok(/_allowances\[from\]\[spender\]/.test(body));
        assert.ok(/currentAllowance - value/.test(body));
    });

    it("_transfer's EOA-side movement is a direct CALL of transferFrom, not a delegatecall (#511 change 1)", function () {
        const body = bodyOf("function _transfer(");
        assert.ok(
            body.includes("address(SplCached).call(") &&
            body.includes('"transferFrom(address,address,uint256,bytes32)"'),
            "the delegate-leg selector must be reached via direct CALL so SplCached signs as external_auth(wrapper)"
        );
        assert.ok(
            !/address\(SplCached\)\.delegatecall\(/.test(body),
            "no SplCached mutating selector may be reached via delegatecall from _transfer post-#511"
        );
    });

    it("_transfer routes a contract recipient's SPL to the wrapper's own ATA, never the contract's", function () {
        const body = bodyOf("function _transfer(");
        assert.ok(
            /toIsContract\s*\?\s*address\(this\)\s*:\s*to/.test(body),
            "destination-address selection must collapse to address(this) for a contract recipient"
        );
    });

    it("_transfer credits the contract-holder escrow ledger with the delivered (post-fee) amount", function () {
        const body = bodyOf("function _transfer(");
        assert.ok(/_escrow\[to\]\s*\+=\s*delivered/.test(body));
    });

    it("_transfer's contract -> contract path is a pure ledger move with no CPI", function () {
        const body = bodyOf("function _transfer(");
        assert.ok(/fromIsContract\s*&&\s*toIsContract/.test(body));
    });

    it("_transfer's contract-holder payout leg uses the owner-path selector via direct CALL", function () {
        const body = bodyOf("function _transfer(");
        assert.ok(
            body.includes("address(SplCached).call(") &&
            body.includes('"transfer(address,uint256,bytes32)"'),
            "contract -> EOA payout: the wrapper is the owner of its own ATA, no delegate needed"
        );
    });

    it("exactly the exempt AssociatedSplCached.create_ata delegatecall sites remain", function () {
        const delegatecallBlocks = [...src.matchAll(/address\((\w+)\)\.delegatecall\(\s*abi\.encodeWithSignature\(\s*"([^"]+)"/g)];
        for (const [, target, sig] of delegatecallBlocks) {
            assert.equal(target, "AssociatedSplCached", `non-exempt delegatecall target post-#511: ${target}(${sig})`);
            assert.ok(sig.startsWith("create_ata"), `non-exempt selector reachable via delegatecall post-#511: ${sig}`);
        }
        assert.equal(delegatecallBlocks.length, 3, `expected exactly 3 exempt delegatecall sites, found: ${delegatecallBlocks.map(m => m[2]).join(", ")}`);
    });

    it("isEnabled(user) reports the one-time SPL-level delegate grant, on this contract's own cached track", function () {
        assert.ok(
            /function isEnabled\(address user\) public view returns \(bool\)/.test(src),
            "SPL_ERC20_cached must expose isEnabled(address), same as the legacy wrapper (scope §4.1/§4.2 change 2)"
        );
        const body = bodyOf("function isEnabled(address user)");
        assert.ok(
            body.includes("SplCached.account("),
            "isEnabled must read via the cached-track SplCached.account, not the legacy HelperProgram.allowance_of " +
            "— mixing tracks in the same contract is the one-track rule this file must not break"
        );
        assert.ok(!body.includes("HelperProgram.allowance_of"), "must not touch the legacy allowance_of selector");
        // The prior version of this test only checked the read call and the
        // absence of the legacy selector — it did not pin the predicate, so
        // `acc.delegated_amount >= 0` (always true) or dropping the delegate
        // check entirely both left 14/14 green. Pin both halves of the
        // boolean explicitly.
        assert.ok(
            /acc\.delegate\s*==\s*HelperProgram\.pda\(address\(this\)\)/.test(body),
            "isEnabled must check the delegate is THIS wrapper's own external_auth PDA, " +
            "not merely that some delegate exists"
        );
        assert.ok(
            /acc\.delegated_amount\s*>\s*0/.test(body),
            "isEnabled's amount check must be strictly '> 0' — '>= 0' is always true " +
            "(delegated_amount is unsigned) and would report every user enabled"
        );
        assert.ok(
            /acc\.delegate\s*==\s*HelperProgram\.pda\(address\(this\)\)\s*&&\s*acc\.delegated_amount\s*>\s*0/.test(body),
            "isEnabled must AND the delegate check with the amount check, not evaluate either alone"
        );
    });

    it("balanceOf(account) dispatches on account.code.length, contract holders read the escrow ledger", function () {
        const body = bodyOf("function balanceOf(address account)");
        assert.ok(/account\.code\.length\s*>\s*0/.test(body));
        assert.ok(/return _escrow\[account\]/.test(body));
    });
});
