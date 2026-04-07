/**
 * Transfer Hook Tests — TDD RED Phase
 *
 * Tests for ITransferHook, TransferHookBase, and KYCHook contracts.
 * These tests define the expected behavior per SPEC-rome-meta-hook.md.
 *
 * SPEC references:
 * - KYCHook.onTransfer with approved address (succeeds)
 * - KYCHook.onTransfer with non-approved address (reverts TransferBlocked)
 * - TransferHookBase.onlyRouter modifier (rejects non-router)
 */

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

describe("KYCHook", function () {
    let kycHook: any;
    let routerAddress: `0x${string}`;
    let ownerAddress: `0x${string}`;
    let nonRouterAddress: `0x${string}`;
    let publicClient: any;
    let walletClients: any[];

    // Dummy Solana pubkeys as bytes32
    const SOURCE = "0x" + "aa".repeat(32) as `0x${string}`;
    const MINT = "0x" + "bb".repeat(32) as `0x${string}`;
    const DESTINATION = "0x" + "cc".repeat(32) as `0x${string}`;
    const AUTHORITY = "0x" + "dd".repeat(32) as `0x${string}`;
    const AMOUNT = 1000000n; // 1M token units

    before(async function () {
        const { viem } = await hardhat.network.connect();
        walletClients = await viem.getWalletClients();
        publicClient = await viem.getPublicClient();

        // First wallet is the owner/deployer, second simulates router
        ownerAddress = walletClients[0].account.address;

        // Use a deterministic address for router simulation
        // In production, router = keccak256(router_program_id ++ "callback_authority")[12..]
        routerAddress = walletClients[1].account.address;
        nonRouterAddress = walletClients[2].account.address;

        // Deploy KYCHook with wallet[1] as the "router"
        kycHook = await viem.deployContract("KYCHook", [routerAddress]);
    });

    // ──────────────────────────────────────────────
    // Deployment & Configuration
    // ──────────────────────────────────────────────

    describe("deployment", function () {
        it("sets router address correctly", async function () {
            const storedRouter = await kycHook.read.router();
            assert.equal(
                storedRouter.toLowerCase(),
                routerAddress.toLowerCase(),
                "Router address should be set to constructor argument"
            );
        });

        it("sets deployer as owner", async function () {
            const storedOwner = await kycHook.read.owner();
            assert.equal(
                storedOwner.toLowerCase(),
                ownerAddress.toLowerCase(),
                "Owner should be the deployer"
            );
        });

        it("reverts deployment with zero router address", async function () {
            const { viem } = await hardhat.network.connect();
            await assert.rejects(
                async () => {
                    await viem.deployContract("KYCHook", [
                        "0x0000000000000000000000000000000000000000",
                    ]);
                },
                /Router address cannot be zero/,
                "Should revert when router is zero address"
            );
        });
    });

    // ──────────────────────────────────────────────
    // KYC Address Management
    // ──────────────────────────────────────────────

    describe("address management", function () {
        it("owner can approve an address", async function () {
            const tx = await kycHook.write.approveAddress([SOURCE], {
                account: walletClients[0].account,
            });
            await publicClient.waitForTransactionReceipt({ hash: tx });

            const isApproved = await kycHook.read.approved([SOURCE]);
            assert.equal(isApproved, true, "Source should be approved after approveAddress");
        });

        it("owner can revoke an address", async function () {
            // First approve
            let tx = await kycHook.write.approveAddress([SOURCE], {
                account: walletClients[0].account,
            });
            await publicClient.waitForTransactionReceipt({ hash: tx });

            // Then revoke
            tx = await kycHook.write.revokeAddress([SOURCE], {
                account: walletClients[0].account,
            });
            await publicClient.waitForTransactionReceipt({ hash: tx });

            const isApproved = await kycHook.read.approved([SOURCE]);
            assert.equal(isApproved, false, "Source should not be approved after revokeAddress");
        });

        it("non-owner cannot approve", async function () {
            await assert.rejects(
                async () => {
                    await kycHook.write.approveAddress([SOURCE], {
                        account: walletClients[2].account,
                    });
                },
                /OnlyOwner/,
                "Non-owner should be rejected"
            );
        });

        it("non-owner cannot revoke", async function () {
            await assert.rejects(
                async () => {
                    await kycHook.write.revokeAddress([SOURCE], {
                        account: walletClients[2].account,
                    });
                },
                /OnlyOwner/,
                "Non-owner should be rejected"
            );
        });
    });

    // ──────────────────────────────────────────────
    // SPEC: KYCHook.onTransfer with approved address (succeeds)
    // ──────────────────────────────────────────────

    describe("onTransfer — approved addresses", function () {
        before(async function () {
            // Approve both source and destination
            let tx = await kycHook.write.approveAddress([SOURCE], {
                account: walletClients[0].account,
            });
            await publicClient.waitForTransactionReceipt({ hash: tx });

            tx = await kycHook.write.approveAddress([DESTINATION], {
                account: walletClients[0].account,
            });
            await publicClient.waitForTransactionReceipt({ hash: tx });
        });

        it("succeeds when both source and destination are KYC approved", async function () {
            // Call from the router address
            const tx = await kycHook.write.onTransfer(
                [SOURCE, MINT, DESTINATION, AUTHORITY, AMOUNT],
                { account: walletClients[1].account }
            );
            const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
            assert.equal(
                receipt.status,
                "success",
                "Transfer should succeed for KYC-approved addresses"
            );
        });
    });

    // ──────────────────────────────────────────────
    // SPEC: KYCHook.onTransfer with non-approved address (reverts TransferBlocked)
    // ──────────────────────────────────────────────

    describe("onTransfer — non-approved addresses", function () {
        const UNAPPROVED_SOURCE = "0x" + "11".repeat(32) as `0x${string}`;
        const UNAPPROVED_DEST = "0x" + "22".repeat(32) as `0x${string}`;

        it("reverts with TransferBlocked when source is not approved", async function () {
            await assert.rejects(
                async () => {
                    await kycHook.write.onTransfer(
                        [UNAPPROVED_SOURCE, MINT, DESTINATION, AUTHORITY, AMOUNT],
                        { account: walletClients[1].account }
                    );
                },
                /TransferBlocked.*KYC_REQUIRED_SOURCE/,
                "Should revert with TransferBlocked for unapproved source"
            );
        });

        it("reverts with TransferBlocked when destination is not approved", async function () {
            await assert.rejects(
                async () => {
                    await kycHook.write.onTransfer(
                        [SOURCE, MINT, UNAPPROVED_DEST, AUTHORITY, AMOUNT],
                        { account: walletClients[1].account }
                    );
                },
                /TransferBlocked.*KYC_REQUIRED_DESTINATION/,
                "Should revert with TransferBlocked for unapproved destination"
            );
        });

        it("reverts when both source and destination are not approved", async function () {
            await assert.rejects(
                async () => {
                    await kycHook.write.onTransfer(
                        [UNAPPROVED_SOURCE, MINT, UNAPPROVED_DEST, AUTHORITY, AMOUNT],
                        { account: walletClients[1].account }
                    );
                },
                /TransferBlocked/,
                "Should revert when neither party is approved"
            );
        });
    });

    // ──────────────────────────────────────────────
    // SPEC: TransferHookBase.onlyRouter modifier (rejects non-router)
    // ──────────────────────────────────────────────

    describe("onlyRouter modifier", function () {
        it("rejects calls from non-router address", async function () {
            await assert.rejects(
                async () => {
                    // Call from non-router address (walletClients[2])
                    await kycHook.write.onTransfer(
                        [SOURCE, MINT, DESTINATION, AUTHORITY, AMOUNT],
                        { account: walletClients[2].account }
                    );
                },
                /OnlyRouter/,
                "Should revert with OnlyRouter when called by non-router"
            );
        });

        it("allows calls from router address", async function () {
            // Ensure addresses are approved first
            let tx = await kycHook.write.approveAddress([SOURCE], {
                account: walletClients[0].account,
            });
            await publicClient.waitForTransactionReceipt({ hash: tx });

            tx = await kycHook.write.approveAddress([DESTINATION], {
                account: walletClients[0].account,
            });
            await publicClient.waitForTransactionReceipt({ hash: tx });

            // Call from router address should succeed
            tx = await kycHook.write.onTransfer(
                [SOURCE, MINT, DESTINATION, AUTHORITY, AMOUNT],
                { account: walletClients[1].account }
            );
            const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
            assert.equal(receipt.status, "success");
        });
    });

    // ──────────────────────────────────────────────
    // Edge cases & boundary tests
    // ──────────────────────────────────────────────

    describe("edge cases", function () {
        it("handles zero amount transfer", async function () {
            // Ensure addresses are approved
            let tx = await kycHook.write.approveAddress([SOURCE], {
                account: walletClients[0].account,
            });
            await publicClient.waitForTransactionReceipt({ hash: tx });

            tx = await kycHook.write.approveAddress([DESTINATION], {
                account: walletClients[0].account,
            });
            await publicClient.waitForTransactionReceipt({ hash: tx });

            // Zero amount should still pass KYC check
            tx = await kycHook.write.onTransfer(
                [SOURCE, MINT, DESTINATION, AUTHORITY, 0n],
                { account: walletClients[1].account }
            );
            const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
            assert.equal(receipt.status, "success", "Zero amount should succeed");
        });

        it("handles max uint64 amount", async function () {
            const maxUint64 = (1n << 64n) - 1n;

            let tx = await kycHook.write.approveAddress([SOURCE], {
                account: walletClients[0].account,
            });
            await publicClient.waitForTransactionReceipt({ hash: tx });

            tx = await kycHook.write.approveAddress([DESTINATION], {
                account: walletClients[0].account,
            });
            await publicClient.waitForTransactionReceipt({ hash: tx });

            tx = await kycHook.write.onTransfer(
                [SOURCE, MINT, DESTINATION, AUTHORITY, maxUint64],
                { account: walletClients[1].account }
            );
            const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
            assert.equal(receipt.status, "success", "Max uint64 amount should succeed");
        });

        it("previously approved then revoked address is blocked", async function () {
            const TEMP_ADDR = "0x" + "ff".repeat(32) as `0x${string}`;

            // Approve
            let tx = await kycHook.write.approveAddress([TEMP_ADDR], {
                account: walletClients[0].account,
            });
            await publicClient.waitForTransactionReceipt({ hash: tx });

            // Revoke
            tx = await kycHook.write.revokeAddress([TEMP_ADDR], {
                account: walletClients[0].account,
            });
            await publicClient.waitForTransactionReceipt({ hash: tx });

            // Transfer should be blocked
            await assert.rejects(
                async () => {
                    await kycHook.write.onTransfer(
                        [TEMP_ADDR, MINT, DESTINATION, AUTHORITY, AMOUNT],
                        { account: walletClients[1].account }
                    );
                },
                /TransferBlocked/,
                "Revoked address should be blocked"
            );
        });
    });
});
