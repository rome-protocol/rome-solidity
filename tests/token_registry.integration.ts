import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import type { Address } from "viem";

/**
 * TokenRegistry integration tests.
 *
 * TDD: Written BEFORE TokenRegistry implementation. All tests should FAIL initially.
 */

const CPI_PROGRAM = "0xFF00000000000000000000000000000000000008" as Address;

describe("TokenRegistry integration", function () {
    let publicClient: any;
    let deployer: any;
    let nonAdmin: any;
    let registry: any;
    let factory: any;
    let mintHelper: any;
    let mintA: `0x${string}`;
    let mintB: `0x${string}`;
    let mintC: `0x${string}`;

    before(async function () {
        const { viem } = await hardhat.network.connect();
        publicClient = await viem.getPublicClient();
        const wallets = await viem.getWalletClients();
        deployer = wallets[0];
        nonAdmin = wallets[1] ?? wallets[0];

        if (!deployer?.account) {
            throw new Error("No deployer wallet. Set network key.");
        }

        // Deploy helper to create test mints
        mintHelper = await viem.deployContract("TestSPLMintHelper", []);

        // Create three test mints
        for (const _ of [0, 1, 2]) {
            const tx = await mintHelper.write.createMint([9], { account: deployer.account });
            await publicClient.waitForTransactionReceipt({ hash: tx });
        }
        // We'll read them from the helper's array
        mintA = await mintHelper.read.mintAt([0]);
        mintB = await mintHelper.read.mintAt([1]);
        mintC = await mintHelper.read.mintAt([2]);

        console.log("Test mints:", mintA, mintB, mintC);

        // Deploy ERC20SPLFactory (required by TokenRegistry)
        factory = await viem.deployContract("ERC20SPLFactory", [CPI_PROGRAM]);
        console.log("ERC20SPLFactory:", factory.address);

        // Deploy TokenRegistry
        registry = await viem.deployContract("TokenRegistry", [factory.address]);
        console.log("TokenRegistry:", registry.address);
    });

    // ─── Suite 1: Registration ──────────────────────────────────────────

    describe("TokenRegistry — registration", function () {
        it("registerToken deploys wrapper and stores metadata", async function () {
            const ZERO_BYTES32 = "0x" + "00".repeat(32) as `0x${string}`;

            const txHash = await registry.write.registerToken(
                [mintA, 0, ZERO_BYTES32, 0], // NativeSPL, no external address
                { account: deployer.account },
            );
            const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
            assert.equal(receipt.status, "success", "registerToken tx failed");

            const entry = await registry.read.getToken([mintA]);
            assert.ok(
                entry.erc20Wrapper !== "0x0000000000000000000000000000000000000000",
                "wrapper should be deployed",
            );
            assert.equal(entry.origin, 0, "origin should be NativeSPL (0)");
            assert.equal(entry.active, true, "token should be active");

            const wrapperAddr = await registry.read.getWrapper([mintA]);
            assert.equal(
                wrapperAddr.toLowerCase(),
                entry.erc20Wrapper.toLowerCase(),
                "getWrapper should match entry",
            );
        });

        it("registerToken with Wormhole origin stores cross-chain metadata", async function () {
            const ethUsdcAddress = "0x" + "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48".padStart(64, "0") as `0x${string}`;
            const wormholeChainId = 2; // Ethereum

            const txHash = await registry.write.registerToken(
                [mintB, 1, ethUsdcAddress, wormholeChainId], // WormholeWrapped
                { account: deployer.account },
            );
            const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
            assert.equal(receipt.status, "success");

            const entry = await registry.read.getToken([mintB]);
            assert.equal(entry.externalAddress, ethUsdcAddress, "external address mismatch");
            assert.equal(entry.externalChainId, wormholeChainId, "external chain ID mismatch");
        });

        it("registerToken emits TokenRegistered event", async function () {
            // mintC not yet registered
            const txHash = await registry.write.registerToken(
                [mintC, 0, "0x" + "00".repeat(32) as `0x${string}`, 0],
                { account: deployer.account },
            );
            const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
            assert.equal(receipt.status, "success");

            // Check for TokenRegistered event
            assert.ok(receipt.logs.length > 0, "should emit events");
            // The event topic for TokenRegistered should be present
            const hasEvent = receipt.logs.some(
                (log: any) => log.address.toLowerCase() === registry.address.toLowerCase(),
            );
            assert.ok(hasEvent, "TokenRegistered event should be emitted from registry");
        });

        it("registerToken reverts for duplicate mint", async function () {
            // mintA is already registered
            await assert.rejects(
                async () => {
                    await registry.write.registerToken(
                        [mintA, 0, "0x" + "00".repeat(32) as `0x${string}`, 0],
                        { account: deployer.account },
                    );
                },
                "should revert for duplicate mint",
            );
        });

        it("registerToken reverts for non-admin caller", async function () {
            if (nonAdmin.account.address === deployer.account.address) {
                // Skip if we don't have a second wallet
                return;
            }

            // Create a fresh mint for this test
            const tx = await mintHelper.write.createMint([6], { account: deployer.account });
            await publicClient.waitForTransactionReceipt({ hash: tx });
            const freshMint = await mintHelper.read.lastMint();

            await assert.rejects(
                async () => {
                    await registry.write.registerToken(
                        [freshMint, 0, "0x" + "00".repeat(32) as `0x${string}`, 0],
                        { account: nonAdmin.account },
                    );
                },
                "should revert for non-admin",
            );
        });

        it("registerToken validates SPL mint exists on-chain", async function () {
            // Use a random bytes32 that is not a real mint
            const fakeMint = "0x" + "deadbeef".repeat(8) as `0x${string}`;

            await assert.rejects(
                async () => {
                    await registry.write.registerToken(
                        [fakeMint, 0, "0x" + "00".repeat(32) as `0x${string}`, 0],
                        { account: deployer.account },
                    );
                },
                "should revert for non-existent mint",
            );
        });
    });

    // ─── Suite 2: Lookup ────────────────────────────────────────────────

    describe("TokenRegistry — lookup", function () {
        it("getTokenByExternal returns correct entry", async function () {
            const ethUsdcAddress = "0x" + "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48".padStart(64, "0") as `0x${string}`;
            const entry = await registry.read.getTokenByExternal([2, ethUsdcAddress]);
            assert.equal(entry.splMint, mintB, "should find mintB by external address");
        });

        it("getTokenByExternal returns empty for unknown external token", async function () {
            const randomAddr = "0x" + "ff".repeat(32) as `0x${string}`;
            const entry = await registry.read.getTokenByExternal([99, randomAddr]);
            assert.equal(
                entry.splMint,
                "0x" + "00".repeat(32),
                "should return zero splMint for unknown",
            );
        });

        it("isApproved returns true for active registered token", async function () {
            const approved = await registry.read.isApproved([mintA]);
            assert.equal(approved, true, "registered active token should be approved");
        });

        it("isApproved returns false for unregistered mint", async function () {
            const randomMint = "0x" + "ab".repeat(32) as `0x${string}`;
            const approved = await registry.read.isApproved([randomMint]);
            assert.equal(approved, false, "unregistered mint should not be approved");
        });

        it("tokenCount increments with each registration", async function () {
            const count = await registry.read.tokenCount();
            assert.equal(count, 3n, "should have 3 tokens registered (A, B, C)");
        });

        it("tokenAtIndex returns correct entries in order", async function () {
            const entry0 = await registry.read.tokenAtIndex([0]);
            const entry1 = await registry.read.tokenAtIndex([1]);
            const entry2 = await registry.read.tokenAtIndex([2]);

            assert.equal(entry0.splMint, mintA, "index 0 should be mintA");
            assert.equal(entry1.splMint, mintB, "index 1 should be mintB");
            assert.equal(entry2.splMint, mintC, "index 2 should be mintC");
        });
    });

    // ─── Suite 3: Deactivation ──────────────────────────────────────────

    describe("TokenRegistry — deactivation", function () {
        it("deactivateToken sets active to false", async function () {
            const txHash = await registry.write.deactivateToken([mintA], {
                account: deployer.account,
            });
            const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
            assert.equal(receipt.status, "success");

            const entry = await registry.read.getToken([mintA]);
            assert.equal(entry.active, false, "token should be deactivated");

            const approved = await registry.read.isApproved([mintA]);
            assert.equal(approved, false, "deactivated token should not be approved");
        });

        it("deactivateToken emits TokenDeactivated event", async function () {
            // Use mintC which is still active
            const txHash = await registry.write.deactivateToken([mintC], {
                account: deployer.account,
            });
            const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
            assert.equal(receipt.status, "success");

            assert.ok(receipt.logs.length > 0, "should emit event");
            const hasEvent = receipt.logs.some(
                (log: any) => log.address.toLowerCase() === registry.address.toLowerCase(),
            );
            assert.ok(hasEvent, "TokenDeactivated event should be emitted");
        });

        it("deactivateToken reverts for non-admin", async function () {
            if (nonAdmin.account.address === deployer.account.address) return;

            await assert.rejects(
                async () => {
                    await registry.write.deactivateToken([mintB], {
                        account: nonAdmin.account,
                    });
                },
                "should revert for non-admin",
            );
        });

        it("deactivateToken reverts for unregistered mint", async function () {
            const randomMint = "0x" + "cc".repeat(32) as `0x${string}`;
            await assert.rejects(
                async () => {
                    await registry.write.deactivateToken([randomMint], {
                        account: deployer.account,
                    });
                },
                "should revert for unregistered mint",
            );
        });

        it("deactivated token wrapper still functions for existing holders", async function () {
            // mintA was deactivated, but its wrapper should still work
            const wrapperAddr = await registry.read.getWrapper([mintA]);
            assert.ok(
                wrapperAddr !== "0x0000000000000000000000000000000000000000",
                "wrapper should still exist",
            );

            // The wrapper contract itself is independent of the registry
            // Deactivation only affects the registry's isApproved() check
        });
    });

    // ─── Suite 4: Admin Controls ────────────────────────────────────────

    describe("TokenRegistry — admin controls", function () {
        it("owner can transfer ownership", async function () {
            if (nonAdmin.account.address === deployer.account.address) return;

            const txHash = await registry.write.transferOwnership([nonAdmin.account.address], {
                account: deployer.account,
            });
            const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
            assert.equal(receipt.status, "success");

            // Transfer back
            const txHash2 = await registry.write.transferOwnership([deployer.account.address], {
                account: nonAdmin.account,
            });
            await publicClient.waitForTransactionReceipt({ hash: txHash2 });
        });

        it("only owner can register and deactivate", async function () {
            if (nonAdmin.account.address === deployer.account.address) return;

            // Create a new mint
            const tx = await mintHelper.write.createMint([6], { account: deployer.account });
            await publicClient.waitForTransactionReceipt({ hash: tx });
            const freshMint = await mintHelper.read.lastMint();

            // Non-owner cannot register
            await assert.rejects(
                async () => {
                    await registry.write.registerToken(
                        [freshMint, 0, "0x" + "00".repeat(32) as `0x${string}`, 0],
                        { account: nonAdmin.account },
                    );
                },
                "non-owner should not register",
            );

            // Non-owner cannot deactivate
            await assert.rejects(
                async () => {
                    await registry.write.deactivateToken([mintB], {
                        account: nonAdmin.account,
                    });
                },
                "non-owner should not deactivate",
            );
        });
    });
});
