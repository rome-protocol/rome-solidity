import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/// structural regression suite for the Token-2022 hooked
/// transfer (scope §4.3), tied 1:1 to the real
/// `contracts/spl_token/token2022_hooked_transfer.sol` and
/// `contracts/erc20spl/erc20spl_token2022_hooked.sol` sources — not a
/// mirror. Same constraint as `tests/erc20spl/direct-call-escrow-shape.test.ts`
/// (see build-legacy.md): `SPL_ERC20_Token2022Hooked`'s constructor calls the
/// live `HelperProgram.mint_info` precompile, so it cannot be *deployed* on
/// hardhat-network. This is the substitute for a behavioral test on the
/// dispatch-mechanism change itself (DELEGATECALL -> direct CALL).
describe("Token2022 hooked transfer dispatch shape (delegatecall gate, scope §4.3)", function () {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const libSrc = readFileSync(
        path.join(root, "contracts", "spl_token", "token2022_hooked_transfer.sol"),
        "utf8"
    );
    const wrapperSrc = readFileSync(
        path.join(root, "contracts", "erc20spl", "erc20spl_token2022_hooked.sol"),
        "utf8"
    );
    const baseSrc = readFileSync(
        path.join(root, "contracts", "erc20spl", "erc20spl.sol"),
        "utf8"
    );

    function bodyOf(src: string, fnSignatureStart: string): string {
        const start = src.indexOf(fnSignatureStart);
        assert.ok(start >= 0, `function not found: ${fnSignatureStart}`);
        const next = src.indexOf("\n    function ", start + fnSignatureStart.length);
        return next === -1 ? src.slice(start) : src.slice(start, next);
    }

    it("transferChecked invokes CpiProgram via direct CALL, not delegatecall", function () {
        const body = bodyOf(libSrc, "function transferChecked(");
        assert.ok(
            body.includes("address(CpiProgram).call("),
            "transferChecked must dispatch via a direct CALL post-the delegatecall gate"
        );
        assert.ok(
            !body.includes(".delegatecall("),
            "transferChecked must not delegatecall CpiProgram — that's the refused pattern"
        );
    });

    it("the stale delegatecall-required rationale is gone", function () {
        assert.ok(
            !/Delegatecall is required/.test(libSrc),
            "the doc comment claiming delegatecall is required must be removed — the premise is false post-the delegatecall gate"
        );
    });

    it("both hooked-transfer call sites sign as the wrapper's own PDA, not msg.sender's", function () {
        assert.equal(
            (wrapperSrc.match(/RomeEVMAccount\.pda\(msg\.sender\)/g) ?? []).length,
            0,
            "no call site may still resolve authority from msg.sender — a direct CALL signs as address(this) regardless of caller"
        );
        assert.equal(
            (wrapperSrc.match(/RomeEVMAccount\.pda\(address\(this\)\)/g) ?? []).length,
            2,
            "_hookedTransfer's transferChecked call and bridgeOutToSolanaWithHookAccounts's transferChecked call must both pass the wrapper's own PDA"
        );
    });

    it("_hookedTransfer passes the wrapper's own PDA as authority", function () {
        const body = bodyOf(wrapperSrc, "function _hookedTransfer(");
        assert.ok(body.includes("RomeEVMAccount.pda(address(this))"));
    });

    it("bridgeOutToSolanaWithHookAccounts passes the wrapper's own PDA as authority", function () {
        const body = bodyOf(wrapperSrc, "function bridgeOutToSolanaWithHookAccounts(");
        assert.ok(body.includes("RomeEVMAccount.pda(address(this))"));
    });

    it("SPL_ERC20Base factors its allowance check/decrement into a reusable _spendAllowance", function () {
        assert.ok(
            /function _spendAllowance\(/.test(baseSrc),
            "erc20spl.sol must expose an internal _spendAllowance the hooked wrapper can reuse, per the one-track/no-duplication rule"
        );
        const transferFromBody = bodyOf(baseSrc, "function transferFrom(address from, address to, uint256 value)");
        assert.ok(
            transferFromBody.includes("_spendAllowance("),
            "the base transferFrom must itself route through _spendAllowance, not duplicate the inline check"
        );
    });

    it("transferFromWithHookAccounts spends the caller's EVM allowance before moving tokens — the wrapper is now a fixed authority, not a per-spender SPL delegate", function () {
        const body = bodyOf(wrapperSrc, "function transferFromWithHookAccounts(");
        assert.ok(
            body.includes("_spendAllowance(from, msg.sender, value)"),
            "post-the delegatecall gate the CPI authority is always the wrapper's own PDA regardless of msg.sender, so the SPL runtime no longer gates who may call on from's behalf — the inherited EVM _allowances mapping (SPL_ERC20Base, §4.1) must be the one and only access-control gate here, exactly as transferFrom already enforces for the non-hooked path"
        );
    });

    it("transferWithHookAccounts does not spend an allowance — from is always msg.sender", function () {
        const body = bodyOf(wrapperSrc, "function transferWithHookAccounts(");
        assert.ok(
            !body.includes("_spendAllowance"),
            "self-transfer needs no allowance check"
        );
    });
});
