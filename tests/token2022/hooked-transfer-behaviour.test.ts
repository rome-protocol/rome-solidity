import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import {
    HELPER_PROGRAM_ADDRESS,
    CPI_PROGRAM_ADDRESS,
    SYSTEM_PROGRAM_ADDRESS,
} from "../precompile-addresses";

// Behavioural coverage of the hooked wrapper's transfer primitive, executed
// against the real deployed contract rather than read as source text.
//
// `direct-call-hooked-shape.test.ts` (same directory) pins the dispatch
// mechanism (CALL not DELEGATECALL, which selector, `pda(address(this))`
// appearing textually) via regex over the source. That is the right tool
// for a text property, but it cannot observe what the contract actually
// does when driven: three text-preserving mutations of `_spendAllowance`
// and `_hookedTransfer` ship green under it because none of them touch the
// pinned strings. This file drives the deployed bytecode instead, using
// `PrecompileMock` (this directory's sibling) to stand in for HelperProgram,
// CpiProgram and SystemProgram — `admission.test.ts` already deploys this
// exact contract the same way.
describe("SPL_ERC20_Token2022Hooked, executed", async () => {
    const HELPER = HELPER_PROGRAM_ADDRESS;
    const CPI = CPI_PROGRAM_ADDRESS;
    const SYSTEM = SYSTEM_PROGRAM_ADDRESS;

    const conn = await network.connect();
    const { viem } = conn;

    const mockProto = await viem.deployContract("PrecompileMock");
    const client = await viem.getPublicClient();
    const code = await client.getCode({ address: mockProto.address });
    assert.ok(code && code !== "0x", "mock must have deployed code to install");
    for (const addr of [HELPER, CPI, SYSTEM]) {
        await conn.provider.request({ method: "hardhat_setCode", params: [addr, code] });
    }

    const helper = await viem.getContractAt("PrecompileMock", HELPER as `0x${string}`);
    const cpi = await viem.getContractAt("PrecompileMock", CPI as `0x${string}`);

    // decimals=6, hook ARMED, feeBps=0 — every case here runs unarmed-fee so
    // `_hookedTransfer` never takes the `balanceOf`-measuring branch, which
    // would need HELPER and CPI to share a balance ledger (they don't; see
    // PrecompileMock's header note).
    const MINT: `0x${string}` =
        "0x0601000000000000000000000000000000000000000000000000000000000042";

    async function deployHooked() {
        const users = await viem.deployContract("ERC20Users");
        return viem.deployContract("SPL_ERC20_Token2022Hooked", [
            MINT,
            CPI,
            "Wrapped",
            "WRAP",
            users.address,
        ]);
    }

    function zeroAddr(tag: number): `0x${string}` {
        return `0x${"0".repeat(39)}${tag}` as `0x${string}`;
    }

    async function hookMetasFor(hooked: any) {
        return [
            { pubkey: await hooked.read.hook_program(), is_signer: false, is_writable: false },
            { pubkey: await hooked.read.validation_account(), is_signer: false, is_writable: false },
        ];
    }

    let hooked: any;
    let deployer: any;
    let spender: any;

    before(async () => {
        hooked = await deployHooked();
        [deployer, spender] = await viem.getWalletClients();
    });

    it("transferFromWithHookAccounts reverts with no approval — the only per-spender gate is live", async () => {
        const from = zeroAddr(1);
        const to = zeroAddr(2);
        const hookMetas = await hookMetasFor(hooked);
        await assert.rejects(
            hooked.write.transferFromWithHookAccounts([from, to, 100n, hookMetas]),
            /ERC20InsufficientAllowance/,
            "a mutation that special-cases the max-approval sentinel too broadly, or that bypasses the allowance check outright, must not open this gate",
        );
    });

    it("transferFromWithHookAccounts succeeds and decrements the allowance exactly", async () => {
        const from = deployer.account.address;
        const to = zeroAddr(3);
        const hookMetas = await hookMetasFor(hooked);

        await hooked.write.approve([spender.account.address, 250n], { account: deployer.account });
        await hooked.write.transferFromWithHookAccounts(
            [from, to, 100n, hookMetas],
            { account: spender.account },
        );

        const remaining = await hooked.read.allowance([from, spender.account.address]);
        assert.equal(remaining, 150n, "a spend must decrement the allowance by exactly the spent value, not bypass the decrement unconditionally");
    });

    it("transferWithHookAccounts succeeds with zero allowance — from == msg.sender needs no grant", async () => {
        const to = zeroAddr(4);
        const hookMetas = await hookMetasFor(hooked);
        // No approve() call anywhere above for this recipient/sender pair —
        // this must not revert on an allowance it was never asked to spend.
        await hooked.write.transferWithHookAccounts([to, 10n, hookMetas], { account: deployer.account });
    });

    it("the recorded CPI account list has metas[0] == ata(from) and metas[2] == ata(to), in that order", async () => {
        const from = deployer.account.address;
        const to = zeroAddr(5);
        const hookMetas = await hookMetasFor(hooked);
        await hooked.write.transferWithHookAccounts([to, 1n, hookMetas], { account: deployer.account });

        const [pubkey0] = await cpi.read.lastInvokeAccount([0n]);
        const [pubkey2] = await cpi.read.lastInvokeAccount([2n]);
        assert.equal(pubkey0, await helper.read.ata([from, MINT]), "metas[0] must be source's ata");
        assert.equal(pubkey2, await helper.read.ata([to, MINT]), "metas[2] must be destination's ata — a mutation that swaps source and destination must not pass");
    });

    it("metas[3] is the wrapper's own PDA, marked as signer", async () => {
        const to = zeroAddr(6);
        const hookMetas = await hookMetasFor(hooked);
        await hooked.write.transferWithHookAccounts([to, 1n, hookMetas], { account: deployer.account });

        const [pubkey3, isSigner3] = await cpi.read.lastInvokeAccount([3n]);
        assert.equal(isSigner3, true, "the wrapper's own PDA must be marked as signer — omitting the signer seed must not pass");
        assert.equal(pubkey3, await helper.read.pda([hooked.address]), "authority must be the wrapper's own PDA regardless of caller, never msg.sender's");
    });

    it("balanceOf reports a contract holder's real SPL amount, not zero", async () => {
        // The base wrapper's `_escrow`-branch balanceOf is what regressed
        // this: `SPL_ERC20_Token2022Hooked` never writes `_escrow` (it's
        // `private` in the base and this wrapper does not escrow at all),
        // so every contract holder read as 0 until balanceOf was overridden
        // to read the real on-chain balance instead.
        const holder = await viem.deployContract("ERC20Users"); // any deployed contract — has code
        await helper.write.setBalance([holder.address, MINT, 500n]);
        const balance = await hooked.read.balanceOf([holder.address]);
        assert.equal(balance, 500n, "a contract holder's balance must read the real SPL amount");

        const eoa = zeroAddr(9);
        await helper.write.setBalance([eoa, MINT, 700n]);
        assert.equal(await hooked.read.balanceOf([eoa]), 700n, "control: the EOA leg must still work");
    });
});
