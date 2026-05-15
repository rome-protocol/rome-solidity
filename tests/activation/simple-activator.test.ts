import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/// FB-4 regression suite for the post-rewrite SimpleActivator's pure
/// arithmetic + predicates. The real `activate()` fires 5 CPIs in one tx
/// (HelperProgram.create_pda + 2× HelperProgram.create_ata + 2×
/// ERC20Users.ensure_user) — those need a live Rome-EVM chain to
/// exercise. This suite locks in the constants, the msg.value gates,
/// and the `isActivated` predicate logic via a pure mirror helper.
///
/// What the real activator does that this CANNOT verify on hardhat:
///   - CPI dispatch + signer derivation (chain-only).
///   - The user PDA actually appearing on Solana with the expected
///     lamports balance (chain-only).
///   - The wUSDC + wSOL ATAs actually being created on Solana, owned
///     by the user's PDA (chain-only).
///   - The ERC20Users mapping being updated on both wrappers (chain-only).
///
/// On a live chain those are verified by the per-call CPI succeeding —
/// any failure to derive or sign properly reverts at the precompile
/// dispatch (`require(success, ...)`) inside `activate()`. The five
/// in-tx CPIs were measured at 234K Solana CU mean (range 218-256K) on
/// Hadrian via the `0xfC07E2Bc9F1179fB567298C4C570C6fFf28980d1` probe
/// 2026-05-15 — 83% headroom under the 1.4M cap.
describe("SimpleActivator post-FB-4 arithmetic + predicates", function () {
    let helper: any;

    const PDA_RENT_LAMPORTS = 890_880n;
    const ATA_RENT_LAMPORTS = 2_039_280n;
    const FRESH_TRANSFER_RESERVE = 10_000_000n;
    const EXPECTED_USER_PDA_FUNDING =
        PDA_RENT_LAMPORTS + 2n * ATA_RENT_LAMPORTS + FRESH_TRANSFER_RESERVE;

    before(async function () {
        const { viem } = await hardhat.network.connect();
        helper = await viem.deployContract("SimpleActivatorHelper", []);
    });

    // ──────────────────────────────────────────────────────────────────
    // Constants — pin the lamport sizing so any future refactor that
    // shifts the funding formula is caught here, not on a live chain.
    // ──────────────────────────────────────────────────────────────────

    describe("constants", function () {
        it("PDA_RENT_LAMPORTS matches Solana rent floor for 0-byte account", async function () {
            // (128 + 0) * 3480 * 2 = 890_880 lamports.
            // Verified against rome-evm-private RomeEVMAccount.minimum_balance(0).
            const result = await helper.read.PDA_RENT_LAMPORTS();
            assert.equal(result, PDA_RENT_LAMPORTS);
        });

        it("ATA_RENT_LAMPORTS matches Solana rent floor for 165-byte SPL Token Account", async function () {
            // (128 + 165) * 3480 * 2 = 2_039_280 lamports.
            // The SPL Token Account fixed layout.
            const result = await helper.read.ATA_RENT_LAMPORTS();
            assert.equal(result, ATA_RENT_LAMPORTS);
        });

        it("FRESH_TRANSFER_RESERVE covers ~5 fresh-recipient ATA-creates", async function () {
            // 10_000_000 lamports / 2_039_280 ≈ 4.9. Sized for ~5
            // transfer-to-fresh-recipient flows before the user has to
            // top up.
            const result = await helper.read.FRESH_TRANSFER_RESERVE();
            assert.equal(result, FRESH_TRANSFER_RESERVE);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // expectedUserPdaFunding — pin the formula so any drift between the
    // helper constant and the activator's USER_PDA_FUNDING is caught.
    // ──────────────────────────────────────────────────────────────────

    describe("expectedUserPdaFunding", function () {
        it("equals PDA_RENT + 2 * ATA_RENT + FRESH_TRANSFER_RESERVE", async function () {
            const result = await helper.read.expectedUserPdaFunding();
            assert.equal(result, EXPECTED_USER_PDA_FUNDING);
        });

        it("equals 14,969,440 lamports (≈ 0.015 SOL)", async function () {
            // Sanity check on the absolute value — anything wildly off
            // here means a constant got bumped without intent.
            const result = await helper.read.expectedUserPdaFunding();
            assert.equal(result, 14_969_440n);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // validatePayment — the strict-equality msg.value gate.
    //
    // Post-FB-4: `activate()` reverts unless msg.value EXACTLY matches
    // activationCost. No overpay refund (caller is expected to call
    // `activationCost()` first and pay exactly).
    // ──────────────────────────────────────────────────────────────────

    describe("validatePayment", function () {
        const ACTIVATION_COST = 1_000_000_000_000_000_000n; // 1 USDC (1e18 wei)

        it("accepts exact match", async function () {
            const result = await helper.read.validatePayment([
                ACTIVATION_COST,
                ACTIVATION_COST,
            ]);
            assert.equal(result, true);
        });

        it("rejects underpayment", async function () {
            const result = await helper.read.validatePayment([
                ACTIVATION_COST - 1n,
                ACTIVATION_COST,
            ]);
            assert.equal(result, false);
        });

        it("rejects overpayment (strict equality — no refund path)", async function () {
            const result = await helper.read.validatePayment([
                ACTIVATION_COST + 1n,
                ACTIVATION_COST,
            ]);
            assert.equal(result, false);
        });

        it("rejects zero msg.value when cost is positive", async function () {
            const result = await helper.read.validatePayment([0n, ACTIVATION_COST]);
            assert.equal(result, false);
        });

        it("accepts zero when cost is zero", async function () {
            // Edge case: a deploy that sets activationCost = 0 (testnet,
            // local dev) — caller can still activate without sending value.
            const result = await helper.read.validatePayment([0n, 0n]);
            assert.equal(result, true);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // isActivatedFromLamports — fully-activated iff PDA + both ATAs
    // exist on Solana (lamports > 0 for each).
    //
    // The real isActivated reads three account_lamports values; this
    // mirror takes the observed values directly.
    // ──────────────────────────────────────────────────────────────────

    describe("isActivatedFromLamports", function () {
        it("true when all three accounts have lamports > 0", async function () {
            const result = await helper.read.isActivatedFromLamports([
                PDA_RENT_LAMPORTS,
                ATA_RENT_LAMPORTS,
                ATA_RENT_LAMPORTS,
            ]);
            assert.equal(result, true);
        });

        it("false when user PDA missing (lamports = 0)", async function () {
            const result = await helper.read.isActivatedFromLamports([
                0n,
                ATA_RENT_LAMPORTS,
                ATA_RENT_LAMPORTS,
            ]);
            assert.equal(result, false);
        });

        it("false when wUSDC ATA missing", async function () {
            const result = await helper.read.isActivatedFromLamports([
                PDA_RENT_LAMPORTS,
                0n,
                ATA_RENT_LAMPORTS,
            ]);
            assert.equal(result, false);
        });

        it("false when wSOL ATA missing", async function () {
            const result = await helper.read.isActivatedFromLamports([
                PDA_RENT_LAMPORTS,
                ATA_RENT_LAMPORTS,
                0n,
            ]);
            assert.equal(result, false);
        });

        it("false when only PDA exists (partial activation aborted halfway)", async function () {
            const result = await helper.read.isActivatedFromLamports([
                PDA_RENT_LAMPORTS,
                0n,
                0n,
            ]);
            assert.equal(result, false);
        });

        it("false when nothing exists (fresh user)", async function () {
            const result = await helper.read.isActivatedFromLamports([0n, 0n, 0n]);
            assert.equal(result, false);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // validateTopUpPayment — `topUpUserPda` accepts any positive amount.
    //
    // Unlike `activate()` (strict equality), topUp is variable-amount.
    // Caller passes whatever they want to add to their PDA reserve.
    // Real function then converts msg.value → SOL via swap_gas_to_lamports.
    // ──────────────────────────────────────────────────────────────────

    describe("validateTopUpPayment", function () {
        it("accepts any positive amount", async function () {
            const result = await helper.read.validateTopUpPayment([1n]);
            assert.equal(result, true);
        });

        it("accepts large amount", async function () {
            const result = await helper.read.validateTopUpPayment([1_000_000_000_000_000_000n]);
            assert.equal(result, true);
        });

        it("rejects zero (must send positive value)", async function () {
            const result = await helper.read.validateTopUpPayment([0n]);
            assert.equal(result, false);
        });
    });
});
