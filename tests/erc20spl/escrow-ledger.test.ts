import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/// Regression suite for the contract-holder escrow: a deployed contract
/// can never call `approve`, so its SPL lives in the wrapper's own ATA and
/// its balance is tracked in an EVM ledger instead. `EscrowLedgerHelper`
/// mirrors the routing + arithmetic; the `code.length` check and SPL CPI
/// need a live chain and are covered by direct-call-escrow-shape.test.ts.
describe("SPL_ERC20 contract-holder escrow", function () {
    let viem: any;
    let helper: any;
    let eoaA: `0x${string}`;
    let eoaB: `0x${string}`;
    let contractA: `0x${string}`;
    let contractB: `0x${string}`;

    const WRAPPER_SENTINEL = "0x0000000000000000000000000000000000000000";

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
        const wallets = await viem.getWalletClients();
        eoaA = wallets[0].account.address;
        eoaB = wallets[1].account.address;
        // Any two distinct deployed contracts stand in for "an address
        // with code" — the helper never calls into them, it only takes
        // their address as a data value.
        const c1 = await viem.deployContract("EvmAllowanceHelper", []);
        const c2 = await viem.deployContract("EvmAllowanceHelper", []);
        contractA = c1.address;
        contractB = c2.address;
    });

    before(async function () {
        helper = await viem.deployContract("EscrowLedgerHelper", []);
    });

    // ── destination-ATA selection ───────────────────────────────────────

    it("EOA recipient: SPL destination is the recipient's own ATA (to, unchanged)", async function () {
        const dest = await helper.read.destinationAta([false, eoaB]);
        assert.equal(dest.toLowerCase(), eoaB.toLowerCase());
    });

    it("contract recipient: SPL destination collapses to the wrapper's own ATA, never the contract's", async function () {
        const dest = await helper.read.destinationAta([true, contractB]);
        assert.equal(dest.toLowerCase(), WRAPPER_SENTINEL, "a contract can never approve — SPL must not land at `to`'s own ATA");
    });

    // ── delegate requirement ────────────────────────────────────────────

    it("EOA-held SPL requires the wrapper to be the sender's SPL delegate", async function () {
        assert.equal(await helper.read.requiresDelegate([false]), true);
    });

    it("contract-held SPL needs no delegate — the wrapper already owns its own ATA", async function () {
        assert.equal(await helper.read.requiresDelegate([true]), false);
    });

    // ── pure-ledger contract -> contract move ───────────────────────────

    it("contract -> contract is flagged as a pure ledger move (no CPI, no fee)", async function () {
        assert.equal(await helper.read.isPureLedgerMove([true, true]), true);
        assert.equal(await helper.read.isPureLedgerMove([true, false]), false);
        assert.equal(await helper.read.isPureLedgerMove([false, true]), false);
        assert.equal(await helper.read.isPureLedgerMove([false, false]), false);
    });

    // ── ledger arithmetic ────────────────────────────────────────────────

    it("creditEscrow increases the ledger by exactly the delivered amount", async function () {
        await helper.write.creditEscrow([contractA, 500n]);
        assert.equal(await helper.read.escrowOf([contractA]), 500n);
    });

    it("crediting a fee-armed delivered amount (< requested value) never over-credits the ledger", async function () {
        // A transfer-fee mint delivers less than the requested value; the
        // ledger must track what actually landed in the wrapper's ATA
        // (the `delivered` amount), not the raw request, or the ledger
        // sum would exceed the wrapper's real on-chain SPL balance.
        const requested = 1000n;
        const fee = 30n;
        const delivered = requested - fee;
        await helper.write.creditEscrow([contractB, delivered]);
        assert.equal(await helper.read.escrowOf([contractB]), delivered);
    });

    it("debitEscrow decreases the ledger by exactly the paid-out value", async function () {
        const fresh = await viem.deployContract("EscrowLedgerHelper", []);
        await fresh.write.creditEscrow([contractA, 1000n]);
        await fresh.write.debitEscrow([contractA, 400n]);
        assert.equal(await fresh.read.escrowOf([contractA]), 600n);
    });

    it("debitEscrow reverts when the escrow balance is insufficient", async function () {
        const fresh = await viem.deployContract("EscrowLedgerHelper", []);
        await assert.rejects(fresh.write.debitEscrow([contractA, 1n]));
    });

    // ── balanceOf dispatch ───────────────────────────────────────────────

    it("balanceOf(contract) returns the escrow ledger, ignoring any on-chain value passed", async function () {
        const fresh = await viem.deployContract("EscrowLedgerHelper", []);
        await fresh.write.creditEscrow([contractA, 777n]);
        const result = await fresh.read.balanceOf([true, contractA, 123456n]);
        assert.equal(result, 777n);
    });

    it("balanceOf(EOA) returns the on-chain SPL value passed through, ignoring the ledger", async function () {
        const fresh = await viem.deployContract("EscrowLedgerHelper", []);
        await fresh.write.creditEscrow([eoaA, 999n]); // ledger entry present but must be ignored for an EOA
        const result = await fresh.read.balanceOf([false, eoaA, 42n]);
        assert.equal(result, 42n);
    });
});
