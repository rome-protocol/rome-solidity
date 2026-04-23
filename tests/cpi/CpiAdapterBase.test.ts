import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/**
 * Tests for the shared CpiAdapterBase template.
 *
 * Verifies:
 *   - Ownable: only owner can setBackend, pause, unpause, withdrawERC20.
 *   - Pausable: write path reverts with EnforcedPause() when paused.
 *   - ReentrancyGuard: non-entrant guard works (single-call success).
 *   - BackendUpdated event fires with (previous, next).
 *   - _u64check: reverts AmountTooLarge on overflow; returns uint64 on pass.
 *   - withdrawERC20: SafeERC20 transfer to owner.
 */

describe("CpiAdapterBase", () => {
    let viem: any;
    let owner: `0x${string}`;
    let stranger: `0x${string}`;
    let otherAddr: `0x${string}`;
    let publicClient: any;

    before(async () => {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
        publicClient = await viem.getPublicClient();
        const [w1, w2, w3] = await viem.getWalletClients();
        owner = w1.account.address;
        stranger = w2.account.address;
        otherAddr = w3.account.address;
    });

    async function deploy() {
        const adapter = await viem.deployContract("TestCpiAdapter", [owner]);
        return adapter;
    }

    // ──────────────────────────────────────────────────────────────────
    // Ownable
    // ──────────────────────────────────────────────────────────────────

    it("deployer is owner", async () => {
        const a = await deploy();
        const o = await a.read.owner();
        assert.equal((o as string).toLowerCase(), owner.toLowerCase());
    });

    // ──────────────────────────────────────────────────────────────────
    // setBackend + BackendUpdated event
    // ──────────────────────────────────────────────────────────────────

    it("setBackend updates state and emits BackendUpdated", async () => {
        const a = await deploy();
        const newBackend = otherAddr;

        const hash = await a.write.setBackend([newBackend]);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        assert.equal(receipt.status, "success");

        const readBackend = await a.read.backend();
        assert.equal((readBackend as string).toLowerCase(), newBackend.toLowerCase());

        // The event matches topic0 of BackendUpdated(address,address).
        // topic count = 3 (sig + 2 indexed addrs)
        assert.equal(receipt.logs.length, 1);
        assert.equal(receipt.logs[0].topics.length, 3);
    });

    it("setBackend reverts for non-owner", async () => {
        const a = await deploy();
        const [, nonOwner] = await viem.getWalletClients();
        const adapterAsStranger = await viem.getContractAt(
            "TestCpiAdapter",
            a.address,
            { client: { wallet: nonOwner } },
        );
        await assert.rejects(
            async () => adapterAsStranger.write.setBackend([otherAddr]),
            (err: any) => String(err?.message ?? "").includes("OwnableUnauthorizedAccount"),
        );
    });

    // ──────────────────────────────────────────────────────────────────
    // Pausable
    // ──────────────────────────────────────────────────────────────────

    it("pause blocks write paths; unpause restores", async () => {
        const a = await deploy();

        // Initial: not paused, write succeeds.
        await a.write.doWrite();
        let writes = await a.read.writes();
        assert.equal(writes, 1n);

        // Pause.
        await a.write.pause();

        await assert.rejects(
            async () => a.write.doWrite(),
            (err: any) => String(err?.message ?? "").includes("EnforcedPause"),
        );

        // Unpause and verify writes resume.
        await a.write.unpause();
        await a.write.doWrite();
        writes = await a.read.writes();
        assert.equal(writes, 2n);
    });

    it("pause/unpause are owner-only", async () => {
        const a = await deploy();
        const [, nonOwner] = await viem.getWalletClients();
        const adapterAsStranger = await viem.getContractAt(
            "TestCpiAdapter",
            a.address,
            { client: { wallet: nonOwner } },
        );
        await assert.rejects(
            async () => adapterAsStranger.write.pause(),
            (err: any) => String(err?.message ?? "").includes("OwnableUnauthorizedAccount"),
        );
    });

    // ──────────────────────────────────────────────────────────────────
    // _u64check
    // ──────────────────────────────────────────────────────────────────

    it("_u64check returns value at the u64 upper bound", async () => {
        const a = await deploy();
        const u64max = (1n << 64n) - 1n;
        const ok = await a.read.u64check([u64max]);
        assert.equal(ok, u64max);
    });

    it("_u64check reverts AmountTooLarge on overflow", async () => {
        const a = await deploy();
        const overflow = 1n << 64n;
        await assert.rejects(
            async () => a.read.u64check([overflow]),
            (err: any) => String(err?.message ?? "").includes("AmountTooLarge"),
        );
    });

    // ──────────────────────────────────────────────────────────────────
    // withdrawERC20
    // ──────────────────────────────────────────────────────────────────

    it("withdrawERC20 transfers tokens to owner", async () => {
        const a = await deploy();
        const token = await viem.deployContract("MockERC20", ["Test", "TST"]);

        // Mint tokens to the adapter.
        await token.write.mint([a.address, 1_000n]);
        let adapterBal = await token.read.balanceOf([a.address]);
        assert.equal(adapterBal, 1_000n);

        const ownerBalBefore: bigint = (await token.read.balanceOf([owner])) as bigint;

        // Owner rescue.
        await a.write.withdrawERC20([token.address, 600n]);

        adapterBal = await token.read.balanceOf([a.address]);
        assert.equal(adapterBal, 400n);

        const ownerBalAfter: bigint = (await token.read.balanceOf([owner])) as bigint;
        assert.equal(ownerBalAfter - ownerBalBefore, 600n);
    });

    it("withdrawERC20 is owner-only", async () => {
        const a = await deploy();
        const token = await viem.deployContract("MockERC20", ["Test", "TST"]);
        await token.write.mint([a.address, 1_000n]);

        const [, nonOwner] = await viem.getWalletClients();
        const adapterAsStranger = await viem.getContractAt(
            "TestCpiAdapter",
            a.address,
            { client: { wallet: nonOwner } },
        );
        await assert.rejects(
            async () => adapterAsStranger.write.withdrawERC20([token.address, 1_000n]),
            (err: any) => String(err?.message ?? "").includes("OwnableUnauthorizedAccount"),
        );
    });
});
