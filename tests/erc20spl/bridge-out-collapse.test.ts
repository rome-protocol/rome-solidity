import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/// FB-5 regression suite for the collapsed `SPL_ERC20.bridgeOutToSolana`.
///
/// Pre-collapse (master): callers had to call `ensureRecipientAta(recipient)`
/// first if the recipient's ATA might not exist; otherwise
/// `bridgeOutToSolana` would revert on the SPL transfer_checked CPI
/// because the destination ATA didn't exist. rome-ui's `useOutboundSplBridge`
/// probed Solana directly to skip the preflight when possible.
///
/// Post-collapse: `bridgeOutToSolana` internally fires the
/// `CreateIdempotent` CPI for the recipient ATA (no-op when already exists)
/// before the SPL transfer. This removes the preflight handshake; rome-ui's
/// hook can drop the probe-then-call dance.
///
/// What this suite covers (pure-Solidity mirror):
///   - The input validation gates (non-zero recipient, value ≤ u64.max).
///   - The `recipientNeedsAta` predicate.
///
/// What needs a live chain to verify (out of scope here):
///   - Test #7: bridgeOutToSolana to fresh recipient (no ATA) → SUCCESS.
///   - Test #8: bridgeOutToSolana to existing-ATA recipient → SUCCESS.
///   - Test #9: bridgeOutToSolana reverts when sender PDA has insufficient
///     lamports to fund the recipient ATA-create.
/// These three integration tests live in the `bridgeOutToSolana` smoke
/// suite (tests against a live chain) and are referenced here for
/// traceability but cannot run on hardhat-network.
describe("SPL_ERC20.bridgeOutToSolana post-collapse (FB-5)", function () {
    let helper: any;

    const U64_MAX = (1n << 64n) - 1n;
    const FAKE_RECIPIENT = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

    before(async function () {
        const { viem } = await hardhat.network.connect();
        helper = await viem.deployContract("BridgeOutCollapseHelper", []);
    });

    // ──────────────────────────────────────────────────────────────────
    // Input validation — the post-collapse bridgeOutToSolana keeps the
    // same two require checks at entry. These tests pin the gates.
    // ──────────────────────────────────────────────────────────────────

    describe("validateBridgeOutInputs", function () {
        it("accepts non-zero recipient + value within u64 range", async function () {
            const result = await helper.read.validateBridgeOutInputs([
                FAKE_RECIPIENT,
                1000n,
            ]);
            assert.equal(result, true);
        });

        it("accepts value == u64.max (saturation boundary)", async function () {
            const result = await helper.read.validateBridgeOutInputs([
                FAKE_RECIPIENT,
                U64_MAX,
            ]);
            assert.equal(result, true);
        });

        it("rejects zero recipient pubkey", async function () {
            const result = await helper.read.validateBridgeOutInputs([
                ZERO_BYTES32,
                1000n,
            ]);
            assert.equal(result, false);
        });

        it("rejects value > u64.max", async function () {
            const result = await helper.read.validateBridgeOutInputs([
                FAKE_RECIPIENT,
                U64_MAX + 1n,
            ]);
            assert.equal(result, false);
        });

        it("rejects both bad inputs (recipient zero AND value overflow)", async function () {
            const result = await helper.read.validateBridgeOutInputs([
                ZERO_BYTES32,
                U64_MAX + 1n,
            ]);
            assert.equal(result, false);
        });

        it("accepts value == 0 (zero-value transfer is a valid ERC20/SPL op)", async function () {
            // Note: SPL transfer_checked accepts zero-amount; emits the
            // event but moves nothing. The wrapper does not gate this.
            const result = await helper.read.validateBridgeOutInputs([
                FAKE_RECIPIENT,
                0n,
            ]);
            assert.equal(result, true);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // recipientNeedsAta — the predicate used inside bridgeOutToSolana
    // to decide whether to fire the CreateIdempotent CPI. The CPI is
    // safe-to-always-fire (the Associated Token Program no-ops when the
    // account already exists), so this skip is a CU optimization only.
    // ──────────────────────────────────────────────────────────────────

    describe("recipientNeedsAta", function () {
        it("true when observed lamports == 0 (ATA does not exist on Solana)", async function () {
            const result = await helper.read.recipientNeedsAta([0n]);
            assert.equal(result, true);
        });

        it("false when observed lamports > 0 (ATA exists, skip create)", async function () {
            // ATA rent floor — 2_039_280 lamports — means the account
            // is rent-exempt and definitely exists.
            const result = await helper.read.recipientNeedsAta([2_039_280n]);
            assert.equal(result, false);
        });

        it("false for any positive observed lamports value", async function () {
            const result = await helper.read.recipientNeedsAta([1n]);
            assert.equal(result, false);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // Live-chain integration tests (referenced — not runnable here)
    //
    // The following scenarios require a live Rome chain because they
    // involve real SPL CPI dispatches. They live in the chain-side smoke
    // suite invoked by /lifecycle:
    //
    //   - bridgeOutToSolana to FRESH recipient (no ATA on Solana) →
    //     SUCCESS (ATA auto-created via inline CreateIdempotent CPI;
    //     SPL transfer follows; recipient now holds the tokens).
    //
    //   - bridgeOutToSolana to EXISTING-ATA recipient → SUCCESS
    //     (CreateIdempotent no-ops; SPL transfer succeeds; observable
    //     CU saving since the inline ATA-create predicate may short-
    //     circuit, but functionally indistinguishable from the fresh
    //     case).
    //
    //   - bridgeOutToSolana from sender with DRAINED PDA RESERVE
    //     (< ATA_RENT lamports) → REVERTS because the inline
    //     CreateIdempotent CPI fails to fund the new account from the
    //     sender's PDA. UI surfaces this as "insufficient PDA reserve —
    //     please topUpUserPda".
    // ──────────────────────────────────────────────────────────────────
});
