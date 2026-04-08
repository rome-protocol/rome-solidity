import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import {
    type PublicClient,
    type WalletClient,
    type Address,
    encodeFunctionData,
    parseAbi,
    decodeEventLog,
    getAddress,
} from "viem";

// ─────────────────────────────────────────────
// Helpers: dummy bytes32 values for CPI calls
// ─────────────────────────────────────────────

const DUMMY_PROGRAM_ID = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
const DUMMY_TARGET_ADDR = "0x00000000000000000000000000000000000000000000000000000000deadbeef" as `0x${string}`;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

/** Minimal account meta for CPI invoke (non-empty array required by EmptyAccounts check). */
function dummyAccountMeta(): { pubkey: `0x${string}`; is_signer: boolean; is_writable: boolean }[] {
    return [
        {
            pubkey: "0x0000000000000000000000000000000000000000000000000000000000000002" as `0x${string}`,
            is_signer: false,
            is_writable: false,
        },
    ];
}

// ─────────────────────────────────────────────
// ABI fragments for functions expected after hardening
// ─────────────────────────────────────────────

const PAUSE_ABI = parseAbi([
    "function pause() external",
    "function unpause() external",
    "function paused() external view returns (bool)",
    "function owner() external view returns (address)",
]);

const BRIDGE_SEND_EVENT_ABI = parseAbi([
    "event BridgeSend(address indexed sender, bytes32 targetAddress, uint16 targetChain, uint64 amount, uint32 nonce)",
]);

const BRIDGE_CLAIM_EVENT_ABI = parseAbi([
    "event BridgeClaim(address indexed claimer, bytes32 tokenBridgeProgramId, uint256 accountCount)",
]);

// ─══════════════════════════════════════════════
// Test suite
// ═══════════════════════════════════════════════

describe("RomeWormholeBridge", function () {
    let bridge: any;
    let publicClient: PublicClient;
    let walletClient: WalletClient;
    let deployer: Address;
    let bridgeAddress: Address;

    before(async function () {
        const { viem } = await hardhat.network.connect();
        bridge = await viem.deployContract("RomeWormholeBridge", []);
        bridgeAddress = bridge.address;
        publicClient = await viem.getPublicClient();
        const walletClients = await viem.getWalletClients();
        walletClient = walletClients[0];
        deployer = walletClient.account!.address;
    });

    // ══════════════════════════════════════════════
    // 1A. Events — BridgeSend / BridgeClaim
    // ══════════════════════════════════════════════

    describe("Events", function () {
        it("sendTransferNative emits BridgeSend event", async function () {
            const hash = await bridge.write.sendTransferNative([
                DUMMY_PROGRAM_ID,       // splTokenProgramId
                dummyAccountMeta(),     // approveAccounts
                1000n,                  // approveAmount
                DUMMY_PROGRAM_ID,       // tokenBridgeProgramId
                dummyAccountMeta(),     // transferAccounts
                1,                      // nonce
                1000n,                  // amount
                0n,                     // fee
                DUMMY_TARGET_ADDR,      // targetAddress
                1,                      // targetChain
            ]);

            const receipt = await publicClient.waitForTransactionReceipt({ hash });

            // Expect at least one BridgeSend event in the logs
            const bridgeSendLogs = receipt.logs.filter((log) => {
                try {
                    decodeEventLog({
                        abi: BRIDGE_SEND_EVENT_ABI,
                        data: log.data,
                        topics: log.topics,
                    });
                    return true;
                } catch {
                    return false;
                }
            });

            assert.ok(
                bridgeSendLogs.length > 0,
                "Expected BridgeSend event to be emitted by sendTransferNative",
            );
        });

        it("sendTransferWrapped emits BridgeSend event", async function () {
            const hash = await bridge.write.sendTransferWrapped([
                DUMMY_PROGRAM_ID,
                dummyAccountMeta(),
                1000n,
                DUMMY_PROGRAM_ID,
                dummyAccountMeta(),
                2,
                500n,
                0n,
                DUMMY_TARGET_ADDR,
                3,
            ]);

            const receipt = await publicClient.waitForTransactionReceipt({ hash });

            const bridgeSendLogs = receipt.logs.filter((log) => {
                try {
                    decodeEventLog({
                        abi: BRIDGE_SEND_EVENT_ABI,
                        data: log.data,
                        topics: log.topics,
                    });
                    return true;
                } catch {
                    return false;
                }
            });

            assert.ok(
                bridgeSendLogs.length > 0,
                "Expected BridgeSend event to be emitted by sendTransferWrapped",
            );
        });

        it("claimCompleteNative emits BridgeClaim event", async function () {
            const hash = await bridge.write.claimCompleteNative([
                DUMMY_PROGRAM_ID,
                dummyAccountMeta(),
            ]);

            const receipt = await publicClient.waitForTransactionReceipt({ hash });

            const bridgeClaimLogs = receipt.logs.filter((log) => {
                try {
                    decodeEventLog({
                        abi: BRIDGE_CLAIM_EVENT_ABI,
                        data: log.data,
                        topics: log.topics,
                    });
                    return true;
                } catch {
                    return false;
                }
            });

            assert.ok(
                bridgeClaimLogs.length > 0,
                "Expected BridgeClaim event to be emitted by claimCompleteNative",
            );
        });

        it("claimCompleteWrapped emits BridgeClaim event", async function () {
            const hash = await bridge.write.claimCompleteWrapped([
                DUMMY_PROGRAM_ID,
                dummyAccountMeta(),
            ]);

            const receipt = await publicClient.waitForTransactionReceipt({ hash });

            const bridgeClaimLogs = receipt.logs.filter((log) => {
                try {
                    decodeEventLog({
                        abi: BRIDGE_CLAIM_EVENT_ABI,
                        data: log.data,
                        topics: log.topics,
                    });
                    return true;
                } catch {
                    return false;
                }
            });

            assert.ok(
                bridgeClaimLogs.length > 0,
                "Expected BridgeClaim event to be emitted by claimCompleteWrapped",
            );
        });

        it("BridgeSend event carries correct amount and nonce", async function () {
            const expectedAmount = 42000n;
            const expectedNonce = 7;

            const hash = await bridge.write.sendTransferNative([
                DUMMY_PROGRAM_ID,
                dummyAccountMeta(),
                42000n,
                DUMMY_PROGRAM_ID,
                dummyAccountMeta(),
                expectedNonce,
                expectedAmount,
                0n,
                DUMMY_TARGET_ADDR,
                1,
            ]);

            const receipt = await publicClient.waitForTransactionReceipt({ hash });

            let decoded: any = null;
            for (const log of receipt.logs) {
                try {
                    decoded = decodeEventLog({
                        abi: BRIDGE_SEND_EVENT_ABI,
                        data: log.data,
                        topics: log.topics,
                    });
                    break;
                } catch {
                    // not this event
                }
            }

            assert.ok(decoded !== null, "Expected BridgeSend event");
            assert.equal(decoded.args.amount, expectedAmount);
            assert.equal(decoded.args.nonce, expectedNonce);
        });
    });

    // ══════════════════════════════════════════════
    // 1B. Input Validation
    // ══════════════════════════════════════════════

    describe("Input Validation", function () {
        // --- sendTransferNative ---

        it("sendTransferNative reverts with amount=0", async function () {
            await assert.rejects(
                async () =>
                    bridge.write.sendTransferNative([
                        DUMMY_PROGRAM_ID,
                        dummyAccountMeta(),
                        0n,                     // approveAmount (zero is fine for approve)
                        DUMMY_PROGRAM_ID,
                        dummyAccountMeta(),
                        1,
                        0n,                     // amount = 0 -> should revert
                        0n,
                        DUMMY_TARGET_ADDR,
                        1,
                    ]),
                (err: any) => {
                    assert.ok(
                        err.message.includes("Zero amount"),
                        `Expected "Zero amount" revert, got: ${err.message}`,
                    );
                    return true;
                },
            );
        });

        it("sendTransferNative reverts with targetAddress=bytes32(0)", async function () {
            await assert.rejects(
                async () =>
                    bridge.write.sendTransferNative([
                        DUMMY_PROGRAM_ID,
                        dummyAccountMeta(),
                        1000n,
                        DUMMY_PROGRAM_ID,
                        dummyAccountMeta(),
                        1,
                        1000n,
                        0n,
                        ZERO_BYTES32,           // targetAddress = 0 -> should revert
                        1,
                    ]),
                (err: any) => {
                    assert.ok(
                        err.message.includes("Invalid target"),
                        `Expected "Invalid target" revert, got: ${err.message}`,
                    );
                    return true;
                },
            );
        });

        it("sendTransferNative reverts with targetChain=0", async function () {
            await assert.rejects(
                async () =>
                    bridge.write.sendTransferNative([
                        DUMMY_PROGRAM_ID,
                        dummyAccountMeta(),
                        1000n,
                        DUMMY_PROGRAM_ID,
                        dummyAccountMeta(),
                        1,
                        1000n,
                        0n,
                        DUMMY_TARGET_ADDR,
                        0,                      // targetChain = 0 -> should revert
                    ]),
                (err: any) => {
                    assert.ok(
                        err.message.includes("Invalid chain"),
                        `Expected "Invalid chain" revert, got: ${err.message}`,
                    );
                    return true;
                },
            );
        });

        // --- sendTransferWrapped ---

        it("sendTransferWrapped reverts with amount=0", async function () {
            await assert.rejects(
                async () =>
                    bridge.write.sendTransferWrapped([
                        DUMMY_PROGRAM_ID,
                        dummyAccountMeta(),
                        0n,
                        DUMMY_PROGRAM_ID,
                        dummyAccountMeta(),
                        1,
                        0n,                     // amount = 0 -> should revert
                        0n,
                        DUMMY_TARGET_ADDR,
                        1,
                    ]),
                (err: any) => {
                    assert.ok(
                        err.message.includes("Zero amount"),
                        `Expected "Zero amount" revert, got: ${err.message}`,
                    );
                    return true;
                },
            );
        });

        it("sendTransferWrapped reverts with targetAddress=bytes32(0)", async function () {
            await assert.rejects(
                async () =>
                    bridge.write.sendTransferWrapped([
                        DUMMY_PROGRAM_ID,
                        dummyAccountMeta(),
                        1000n,
                        DUMMY_PROGRAM_ID,
                        dummyAccountMeta(),
                        1,
                        1000n,
                        0n,
                        ZERO_BYTES32,           // targetAddress = 0 -> should revert
                        1,
                    ]),
                (err: any) => {
                    assert.ok(
                        err.message.includes("Invalid target"),
                        `Expected "Invalid target" revert, got: ${err.message}`,
                    );
                    return true;
                },
            );
        });

        it("sendTransferWrapped reverts with targetChain=0", async function () {
            await assert.rejects(
                async () =>
                    bridge.write.sendTransferWrapped([
                        DUMMY_PROGRAM_ID,
                        dummyAccountMeta(),
                        1000n,
                        DUMMY_PROGRAM_ID,
                        dummyAccountMeta(),
                        1,
                        1000n,
                        0n,
                        DUMMY_TARGET_ADDR,
                        0,                      // targetChain = 0 -> should revert
                    ]),
                (err: any) => {
                    assert.ok(
                        err.message.includes("Invalid chain"),
                        `Expected "Invalid chain" revert, got: ${err.message}`,
                    );
                    return true;
                },
            );
        });

        // --- invoke with empty accounts (already works) ---

        it("invoke reverts with empty accounts (EmptyAccounts)", async function () {
            await assert.rejects(
                async () =>
                    bridge.write.invoke([
                        DUMMY_PROGRAM_ID,
                        [],                     // empty accounts -> EmptyAccounts()
                        "0x00" as `0x${string}`,
                    ]),
                (err: any) => {
                    assert.ok(
                        err.message.includes("EmptyAccounts") || err.message.includes("revert"),
                        `Expected EmptyAccounts revert, got: ${err.message}`,
                    );
                    return true;
                },
            );
        });
    });

    // ══════════════════════════════════════════════
    // 1C. Emergency Pause (Pausable + Ownable)
    // ══════════════════════════════════════════════

    describe("Emergency Pause", function () {
        /**
         * Helper: call a function on the bridge via raw encoded data.
         * Used for pause/unpause/owner/paused which may not exist in the
         * current compiled ABI. Returns the tx hash.
         */
        async function rawWrite(data: `0x${string}`): Promise<`0x${string}`> {
            return walletClient.sendTransaction({
                to: bridgeAddress,
                data,
                chain: walletClient.chain,
                account: walletClient.account!,
            });
        }

        async function rawRead(data: `0x${string}`): Promise<`0x${string}`> {
            return publicClient.call({
                to: bridgeAddress,
                data,
            }).then((r) => r.data ?? "0x");
        }

        it("owner() returns deployer address", async function () {
            const data = encodeFunctionData({ abi: PAUSE_ABI, functionName: "owner" });
            const result = await rawRead(data);

            // Should return a 32-byte padded address
            assert.ok(
                result.length >= 66, // 0x + 64 hex chars
                `Expected owner() to return an address, got: ${result}`,
            );

            // Decode the address from the return data
            const ownerAddr = getAddress("0x" + result.slice(26));
            assert.equal(
                ownerAddr.toLowerCase(),
                deployer.toLowerCase(),
                `Expected owner to be deployer ${deployer}, got ${ownerAddr}`,
            );
        });

        it("paused() returns false by default", async function () {
            const data = encodeFunctionData({ abi: PAUSE_ABI, functionName: "paused" });
            const result = await rawRead(data);

            // Should return a bool (0 = false)
            assert.ok(
                result.length >= 66,
                `Expected paused() to return a bool, got: ${result}`,
            );

            const pausedValue = BigInt(result);
            assert.equal(pausedValue, 0n, "Expected paused() to be false (0)");
        });

        it("pause() can be called by owner", async function () {
            // This test will fail because pause() doesn't exist on the current contract
            const data = encodeFunctionData({ abi: PAUSE_ABI, functionName: "pause" });
            const hash = await rawWrite(data);
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            assert.equal(receipt.status, "success", "pause() should succeed when called by owner");

            // Verify paused state
            const pausedData = encodeFunctionData({ abi: PAUSE_ABI, functionName: "paused" });
            const pausedResult = await rawRead(pausedData);
            const pausedValue = BigInt(pausedResult);
            assert.equal(pausedValue, 1n, "Expected paused() to be true (1) after pause()");

            // Unpause for subsequent tests
            const unpauseData = encodeFunctionData({ abi: PAUSE_ABI, functionName: "unpause" });
            const unpauseHash = await rawWrite(unpauseData);
            await publicClient.waitForTransactionReceipt({ hash: unpauseHash });
        });

        it("sendTransferNative reverts when paused", async function () {
            // First, pause the contract
            const pauseData = encodeFunctionData({ abi: PAUSE_ABI, functionName: "pause" });
            const pauseHash = await rawWrite(pauseData);
            await publicClient.waitForTransactionReceipt({ hash: pauseHash });

            // Now try sendTransferNative — should revert with EnforcedPause or similar
            await assert.rejects(
                async () =>
                    bridge.write.sendTransferNative([
                        DUMMY_PROGRAM_ID,
                        dummyAccountMeta(),
                        1000n,
                        DUMMY_PROGRAM_ID,
                        dummyAccountMeta(),
                        1,
                        1000n,
                        0n,
                        DUMMY_TARGET_ADDR,
                        1,
                    ]),
                (err: any) => {
                    assert.ok(
                        err.message.includes("EnforcedPause") || err.message.includes("paused"),
                        `Expected pause revert, got: ${err.message}`,
                    );
                    return true;
                },
            );

            // Unpause for subsequent tests
            const unpauseData = encodeFunctionData({ abi: PAUSE_ABI, functionName: "unpause" });
            const unpauseHash = await rawWrite(unpauseData);
            await publicClient.waitForTransactionReceipt({ hash: unpauseHash });
        });

        it("sendTransferWrapped reverts when paused", async function () {
            const pauseData = encodeFunctionData({ abi: PAUSE_ABI, functionName: "pause" });
            const pauseHash = await rawWrite(pauseData);
            await publicClient.waitForTransactionReceipt({ hash: pauseHash });

            await assert.rejects(
                async () =>
                    bridge.write.sendTransferWrapped([
                        DUMMY_PROGRAM_ID,
                        dummyAccountMeta(),
                        1000n,
                        DUMMY_PROGRAM_ID,
                        dummyAccountMeta(),
                        1,
                        1000n,
                        0n,
                        DUMMY_TARGET_ADDR,
                        1,
                    ]),
                (err: any) => {
                    assert.ok(
                        err.message.includes("EnforcedPause") || err.message.includes("paused"),
                        `Expected pause revert, got: ${err.message}`,
                    );
                    return true;
                },
            );

            const unpauseData = encodeFunctionData({ abi: PAUSE_ABI, functionName: "unpause" });
            const unpauseHash = await rawWrite(unpauseData);
            await publicClient.waitForTransactionReceipt({ hash: unpauseHash });
        });

        it("claimCompleteNative reverts when paused", async function () {
            const pauseData = encodeFunctionData({ abi: PAUSE_ABI, functionName: "pause" });
            const pauseHash = await rawWrite(pauseData);
            await publicClient.waitForTransactionReceipt({ hash: pauseHash });

            await assert.rejects(
                async () =>
                    bridge.write.claimCompleteNative([
                        DUMMY_PROGRAM_ID,
                        dummyAccountMeta(),
                    ]),
                (err: any) => {
                    assert.ok(
                        err.message.includes("EnforcedPause") || err.message.includes("paused"),
                        `Expected pause revert, got: ${err.message}`,
                    );
                    return true;
                },
            );

            const unpauseData = encodeFunctionData({ abi: PAUSE_ABI, functionName: "unpause" });
            const unpauseHash = await rawWrite(unpauseData);
            await publicClient.waitForTransactionReceipt({ hash: unpauseHash });
        });

        it("claimCompleteWrapped reverts when paused", async function () {
            const pauseData = encodeFunctionData({ abi: PAUSE_ABI, functionName: "pause" });
            const pauseHash = await rawWrite(pauseData);
            await publicClient.waitForTransactionReceipt({ hash: pauseHash });

            await assert.rejects(
                async () =>
                    bridge.write.claimCompleteWrapped([
                        DUMMY_PROGRAM_ID,
                        dummyAccountMeta(),
                    ]),
                (err: any) => {
                    assert.ok(
                        err.message.includes("EnforcedPause") || err.message.includes("paused"),
                        `Expected pause revert, got: ${err.message}`,
                    );
                    return true;
                },
            );

            const unpauseData = encodeFunctionData({ abi: PAUSE_ABI, functionName: "unpause" });
            const unpauseHash = await rawWrite(unpauseData);
            await publicClient.waitForTransactionReceipt({ hash: unpauseHash });
        });

        it("non-owner cannot pause", async function () {
            // Get a second wallet client
            const { viem } = await hardhat.network.connect();
            const allClients = await viem.getWalletClients();
            if (allClients.length < 2) {
                assert.fail("Need at least 2 accounts to test non-owner access");
            }
            const nonOwner = allClients[1];

            const pauseData = encodeFunctionData({ abi: PAUSE_ABI, functionName: "pause" });

            // Attempt the call — expect it to revert (either OwnableUnauthorizedAccount
            // when hardened, or "function selector was not recognized" before hardening).
            // We use eth_call to avoid tx-submission timeout issues on Hardhat EDR.
            await assert.rejects(
                async () => {
                    await publicClient.call({
                        account: nonOwner.account!,
                        to: bridgeAddress,
                        data: pauseData,
                    });
                },
                (err: any) => {
                    assert.ok(
                        err.message.includes("OwnableUnauthorizedAccount") ||
                            err.message.includes("revert") ||
                            err.message.includes("not the owner") ||
                            err.message.includes("function selector was not recognized"),
                        `Expected ownership or selector revert, got: ${err.message}`,
                    );
                    return true;
                },
            );

            // The test FAILS in RED phase because the revert is "selector not recognized"
            // (no pause() exists). After hardening, non-owner calls should revert with
            // OwnableUnauthorizedAccount specifically.
            // To properly verify non-owner *access control*, we need the function to exist
            // first. So we assert that the error IS specifically OwnableUnauthorizedAccount.
            // This will fail now (selector not found) and pass after hardening.
            const errMsg = await publicClient.call({
                account: nonOwner.account!,
                to: bridgeAddress,
                data: pauseData,
            }).then(
                () => "no-error",
                (err: any) => err.message as string,
            );

            assert.ok(
                errMsg.includes("OwnableUnauthorizedAccount"),
                `Expected OwnableUnauthorizedAccount, got: ${errMsg}`,
            );
        });

        it("non-owner cannot unpause", async function () {
            const { viem } = await hardhat.network.connect();
            const allClients = await viem.getWalletClients();
            if (allClients.length < 2) {
                assert.fail("Need at least 2 accounts to test non-owner access");
            }
            const nonOwner = allClients[1];

            const unpauseData = encodeFunctionData({ abi: PAUSE_ABI, functionName: "unpause" });

            const errMsg = await publicClient.call({
                account: nonOwner.account!,
                to: bridgeAddress,
                data: unpauseData,
            }).then(
                () => "no-error",
                (err: any) => err.message as string,
            );

            assert.ok(
                errMsg.includes("OwnableUnauthorizedAccount"),
                `Expected OwnableUnauthorizedAccount, got: ${errMsg}`,
            );
        });

        it("unpaused state allows sendTransferNative", async function () {
            // Ensure not paused, then call should succeed (not revert with pause error)
            // On Hardhat the CPI delegatecall succeeds silently, so the function should complete
            const hash = await bridge.write.sendTransferNative([
                DUMMY_PROGRAM_ID,
                dummyAccountMeta(),
                1000n,
                DUMMY_PROGRAM_ID,
                dummyAccountMeta(),
                1,
                1000n,
                0n,
                DUMMY_TARGET_ADDR,
                1,
            ]);

            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            assert.equal(receipt.status, "success", "sendTransferNative should succeed when not paused");
        });
    });

    // ══════════════════════════════════════════════
    // Encoding helpers on bridge (SPL Approve)
    // ══════════════════════════════════════════════

    describe("SPL Approve Encoding", function () {
        it("encodeSplTokenApprove(1000) returns 9 bytes: 0x04 + LE(1000)", async function () {
            const result: string = await bridge.read.encodeSplTokenApprove([1000n]);

            const bytes = Buffer.from(result.slice(2), "hex");

            // Length = 9
            assert.equal(bytes.length, 9, "SPL approve encoding should be 9 bytes");

            // Discriminator = 4
            assert.equal(bytes[0], 4, "SPL Approve discriminator should be 4");

            // Amount 1000 in LE = 0xe803000000000000
            assert.equal(bytes.readBigUInt64LE(1), 1000n);
        });

        it("encodeSplTokenApprove(0) returns 9 bytes with zero amount", async function () {
            const result: string = await bridge.read.encodeSplTokenApprove([0n]);

            const bytes = Buffer.from(result.slice(2), "hex");
            assert.equal(bytes.length, 9);
            assert.equal(bytes[0], 4);
            assert.equal(bytes.readBigUInt64LE(1), 0n);
        });

        it("encodeSplTokenApprove(u64_max) encodes max uint64", async function () {
            const u64Max = 18446744073709551615n;
            const result: string = await bridge.read.encodeSplTokenApprove([u64Max]);

            const bytes = Buffer.from(result.slice(2), "hex");
            assert.equal(bytes.length, 9);
            assert.equal(bytes[0], 4);
            assert.equal(bytes.readBigUInt64LE(1), u64Max);
        });
    });
});
