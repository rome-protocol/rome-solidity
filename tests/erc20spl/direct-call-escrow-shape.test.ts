import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import hardhat from "hardhat";

/// Structural regression suite: regex/text assertions against the real
/// `contracts/erc20spl/erc20spl.sol` source and compiled artifact — not a
/// hand-copied mirror, so mutating the dispatch mechanism (delegatecall ->
/// direct CALL) can't slip past a behavioral-only suite that never reads
/// the file itself. `escrow-ata-immutable.test.ts` and
/// `cached-transfer-behaviour.test.ts` are the complementary behavioral
/// suites, deploying the real contracts and driving actual transfers.
describe("SPL_ERC20 dispatch shape — structural, source-of-truth is the file itself", function () {
    const srcPath = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..", "..", "contracts", "erc20spl", "erc20spl.sol"
    );
    const src = readFileSync(srcPath, "utf8");

    function bodyOf(fnSignatureStart: string): string {
        const start = src.indexOf(fnSignatureStart);
        assert.ok(start >= 0, `function not found: ${fnSignatureStart}`);
        // Next top-level `    function ` (4-space indent) after this one
        // marks the end of this function's body inside SPL_ERC20Base.
        const next = src.indexOf("\n    function ", start + fnSignatureStart.length);
        return next === -1 ? src.slice(start) : src.slice(start, next);
    }

    it("mint_to no longer exists in source", function () {
        assert.ok(!/function mint_to\(/.test(src), "mint_to must be deleted");
    });

    it("mint_to is absent from the compiled ABI", async function () {
        const hre: any = hardhat;
        const artifact = await hre.artifacts.readArtifact("SPL_ERC20");
        const hasMintTo = artifact.abi.some((entry: any) => entry.type === "function" && entry.name === "mint_to");
        assert.equal(hasMintTo, false);
    });

    it("approve() never calls the approve_spl precompile — allowance is pure EVM now", function () {
        const body = bodyOf("function approve(address spender, uint256 value)");
        assert.ok(!body.includes('"approve_spl'), "approve() must not encode a call to approve_spl");
        assert.ok(!body.includes(".delegatecall(") && !body.includes(".call(address(HelperProgram")
            && !body.includes("address(HelperProgram).call(") && !body.includes("address(HelperProgram).delegatecall("),
            "approve() must not touch HelperProgram at all — it's pure EVM storage now");
    });

    it("allowance() never calls the allowance_of precompile — allowance is pure EVM now", function () {
        const body = bodyOf("function allowance(address owner, address spender)");
        assert.ok(!body.includes("allowance_of"), "allowance() must not read via the allowance_of precompile");
        assert.ok(!body.includes("HelperProgram."), "allowance() must not touch HelperProgram at all — it's pure EVM storage now");
    });

    it("approve() writes the EVM allowance mapping directly", function () {
        const body = bodyOf("function approve(address spender, uint256 value)");
        assert.ok(/_allowances\[msg\.sender\]\[spender\]\s*=\s*value/.test(body));
        assert.ok(/emit Approval\(msg\.sender, spender, value\)/.test(body));
    });

    it("allowance() reads the EVM mapping directly", function () {
        const body = bodyOf("function allowance(address owner, address spender)");
        assert.ok(/return _allowances\[owner\]\[spender\]/.test(body));
    });

    it("_transfer's EOA-side movement is a direct CALL, not a delegatecall", function () {
        const body = bodyOf("function _transfer(");
        assert.ok(
            body.includes('address(HelperProgram).call(') &&
            body.includes('"transfer_spl(address,address,uint64,bytes32)"'),
            "the addr-keyed delegate overload must be reached via direct CALL so the precompile signs as external_auth(wrapper)"
        );
        assert.ok(
            !/address\(HelperProgram\)\.delegatecall\(\s*abi\.encodeWithSignature\(\s*"transfer_spl/.test(body),
            "no transfer_spl variant may be reached via delegatecall from _transfer"
        );
    });

    it("_transfer routes a contract recipient's SPL to the wrapper's own ATA, never the contract's", function () {
        const body = bodyOf("function _transfer(");
        assert.ok(
            /toIsContract\s*\?\s*address\(this\)\s*:\s*to/.test(body),
            "destination-address selection must collapse to address(this) for a contract recipient — " +
            "flipping this line is the exact mutation that proves the escrow test is load-bearing, not decorative"
        );
    });

    it("_transfer credits the contract-holder escrow ledger with the delivered (post-fee) amount, not the raw request", function () {
        const body = bodyOf("function _transfer(");
        assert.ok(/_escrow\[to\]\s*\+=\s*delivered/.test(body));
    });

    it("_transfer's contract -> contract path is a pure ledger move with no CPI", function () {
        const body = bodyOf("function _transfer(");
        assert.ok(/fromIsContract\s*&&\s*toIsContract/.test(body));
    });

    it("_transfer's contract-holder payout leg uses the 3-arg owner-path selector via direct CALL", function () {
        const body = bodyOf("function _transfer(");
        assert.ok(
            body.includes('address(HelperProgram).call(') &&
            body.includes('"transfer_spl(address,uint64,bytes32)"'),
            "contract -> EOA payout: the wrapper is the owner of its own ATA, no delegate needed"
        );
    });

    it("bridgeOutToSolana's SPL move is a direct CALL of the delegate-ATA overload, not a delegatecall", function () {
        const body = bodyOf("function bridgeOutToSolana(");
        assert.ok(
            body.includes('address(HelperProgram).call(') &&
            body.includes('"transfer_spl(bytes32,bytes32,uint64,bytes32)"'),
            "the caller-supplied-src_ata delegate overload, direct-CALLed so the wrapper signs as the user's delegate"
        );
        assert.ok(
            !body.includes('address(HelperProgram).delegatecall(\n            abi.encodeWithSignature(\n                "transfer_spl'),
            "the old delegatecall of the non-exempt transfer leg must be gone"
        );
    });

    it("exactly the exempt create_ata / create_ata_for_key selectors remain reachable via delegatecall", function () {
        const delegatecallBlocks = [...src.matchAll(/address\(HelperProgram\)\.delegatecall\(\s*abi\.encodeWithSignature\(\s*"([^"]+)"/g)]
            .map((m) => m[1]);
        for (const sig of delegatecallBlocks) {
            assert.ok(
                sig.startsWith("create_ata"),
                `non-exempt selector reachable via delegatecall: ${sig}`
            );
        }
        // The four create_ata-family call sites this file is expected to
        // keep (create_token_account, bridgeOutToSolana's ATA-create,
        // ensureRecipientAta, and the wrapper's own escrow-ATA ensure).
        assert.equal(delegatecallBlocks.length, 4, `expected exactly 4 exempt delegatecall sites, found: ${delegatecallBlocks.join(", ")}`);
    });

    it("isEnabled(user) reports the one-time SPL-level delegate grant", function () {
        assert.ok(
            /function isEnabled\(address user\) public view returns \(bool\)/.test(src),
            "SPL_ERC20Base must expose isEnabled(address) — the only way a caller can check " +
            "whether `user` has sent the one-time approve_spl(wrapper, …, mint) grant this " +
            "wrapper now depends on for every EOA-side transfer"
        );
        const body = bodyOf("function isEnabled(address user)");
        assert.ok(
            /HelperProgram\.allowance_of\(\s*user,\s*address\(this\),\s*mint_id\s*\)\s*>\s*0/.test(body),
            "isEnabled must return whether the grant is non-zero (allowance_of(...) > 0) — " +
            ">= 0 would always report true and defeat the whole point of the check"
        );
    });

    /// `_spendAllowance` was extracted specifically so `transferFromWithHookAccounts`
    /// could reuse it — its own doc comment calls it "the only per-spender
    /// access control" now that a direct CALL always signs as
    /// external_auth(address(this)). No existing test (here or in
    /// tests/token2022/direct-call-hooked-shape.test.ts) pinned the actual
    /// comparison operators, only that the function exists and is called.
    /// Verified independently: mutating `currentAllowance < value` to
    /// `currentAllowance < value / 2` (lets a spender move up to 2x their
    /// approved amount before reverting) left the full erc20spl+activation+
    /// token2022 suite at 190/190 green before this test was added.
    it("_spendAllowance reverts a spend that exceeds the exact remaining allowance, and skips decrement only at the infinite-approval sentinel", function () {
        const body = bodyOf("function _spendAllowance(address owner, address spender, uint256 value)");
        assert.ok(
            /currentAllowance\s*!=\s*type\(uint256\)\.max/.test(body),
            "must special-case exactly type(uint256).max as the infinite-approval sentinel — " +
            "any other comparison either saturates a finite approval early or never lets a real max approval skip the decrement"
        );
        assert.ok(
            /currentAllowance\s*<\s*value\s*\)/.test(body),
            "the insufficient-allowance guard must be a strict '<' against exactly the full requested " +
            "value (immediately closed by the if's parenthesis) — '<=' would revert on an exact-match " +
            "spend, and any scaled comparison (e.g. value/2) would let a spender move more than they " +
            "were approved for"
        );
        assert.ok(
            /_allowances\[owner\]\[spender\]\s*=\s*currentAllowance\s*-\s*value/.test(body),
            "the decrement must subtract the exact spent value from the exact current allowance"
        );
    });
});
