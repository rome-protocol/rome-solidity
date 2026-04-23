import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/**
 * Tests for CostEstimator — Pillar B rent + USD + audit-trail helpers.
 *
 * Rent cases (§7 Task 7 step 4):
 *   rentForSpace(0)    == 890_880
 *   rentForSpace(82)   == 1_461_600
 *   rentForSpace(165)  == 2_039_280
 *   rentForSpace(2560) == 18_699_840  (Kamino obligation)
 *   rentForSpace(3232) == 23_377_920  (Drift User 3232-byte variant)
 *
 * USD cases verify 1e8-scale arithmetic and that the oracleReads audit
 * trail captures the exact adapter addresses consulted, in call order.
 */

const SOL_USD_PRICE = 200n * 10n ** 8n;    // $200.00 at 1e8 scale
const ETH_USD_PRICE = 3500n * 10n ** 8n;   // $3500.00 at 1e8 scale

describe("CostEstimator", () => {
    let viem: any;
    let harness: any;
    let solUsd: any;
    let ethUsd: any;

    before(async () => {
        const conn = await hardhat.network.connect();
        viem = conn.viem;

        harness = await viem.deployContract("CostEstimatorHarness", []);
        solUsd = await viem.deployContract("MockPriceAdapter", [SOL_USD_PRICE]);
        ethUsd = await viem.deployContract("MockPriceAdapter", [ETH_USD_PRICE]);
    });

    // ──────────────────────────────────────────────────────────────────
    // Rent table
    // ──────────────────────────────────────────────────────────────────

    it("rentForAta == SPL_TOKEN_ACCOUNT_RENT == 2_039_280", async () => {
        assert.equal(await harness.read.rentForAta(), 2_039_280n);
        assert.equal(
            await harness.read.SPL_TOKEN_ACCOUNT_RENT(),
            2_039_280n,
        );
    });

    it("rentForSpace(0) == 890_880", async () => {
        assert.equal(await harness.read.rentForSpace([0n]), 890_880n);
        assert.equal(await harness.read.ZERO_SPACE_RENT(), 890_880n);
    });

    it("rentForSpace(82) == 1_461_600 (mint)", async () => {
        assert.equal(await harness.read.rentForSpace([82n]), 1_461_600n);
        assert.equal(await harness.read.MINT_ACCOUNT_RENT(), 1_461_600n);
    });

    it("rentForSpace(165) == 2_039_280 (SPL Token / ATA)", async () => {
        assert.equal(await harness.read.rentForSpace([165n]), 2_039_280n);
    });

    it("rentForSpace(2560) == 18_708_480 (Kamino obligation, formula-exact)", async () => {
        // cardo-foundation §7 Task 7's acceptance row said 18_699_840 — that
        // value doesn't reconcile with the canonical (128+space)*6960 formula
        // the same spec mandates. The formula and rome_evm_account.sol's
        // minimum_balance agree at (128+2560)*6960 = 18_708_480. We match the
        // formula (the spec's literal is a typo).
        assert.equal(await harness.read.rentForSpace([2560n]), 18_708_480n);
        assert.equal((128n + 2560n) * 6960n, 18_708_480n);
    });

    it("rentForSpace(3232) == 23_385_600 (Drift User, formula-exact)", async () => {
        // Spec table row listed 23_377_920; formula gives (128+3232)*6960 =
        // 23_385_600. See rentForSpace(2560) note.
        assert.equal(await harness.read.rentForSpace([3232n]), 23_385_600n);
    });

    it("MULTISIG_RENT (constant) matches the formula for space=355", async () => {
        // Spec text listed `uint64 constant MULTISIG_RENT = 2_477_760` for
        // space=355, but (128+355)*6960 = 3_361_680. MULTISIG_RENT is
        // therefore set to 3_361_680 (formula-exact) and pinned here.
        const expected = (128n + 355n) * 6960n;
        assert.equal(await harness.read.MULTISIG_RENT(), expected);
        assert.equal(await harness.read.rentForSpace([355n]), expected);
    });

    it("rentForSpace canonical formula: (128 + space) * 6960", async () => {
        for (const space of [10n, 100n, 1_000n, 10_000n]) {
            const expected = (128n + space) * 6960n;
            assert.equal(await harness.read.rentForSpace([space]), expected);
        }
    });

    // ──────────────────────────────────────────────────────────────────
    // sumLamportsRent — skips alreadyExists
    // ──────────────────────────────────────────────────────────────────

    it("sumLamportsRent sums only not-already-existing accounts", async () => {
        const lamports = [1_000n, 2_000n, 3_000n];
        const exists = [false, true, false];
        const got = await harness.read.sumLamportsRent([lamports, exists]);
        assert.equal(got, 4_000n); // 1000 + 3000
    });

    // ──────────────────────────────────────────────────────────────────
    // usdValue — lamports × solUsdPriceE8 / 1e9 + audit trail
    // ──────────────────────────────────────────────────────────────────

    it("usdValue(1_000_000_000 lamports, SOL/USD@$200) == $200.00 usd8", async () => {
        const [usd8, reads]: [bigint, readonly string[]] = (await harness.read.usdValueWithReads([
            1_000_000_000n, // 1 SOL
            solUsd.address,
            1n,
        ])) as any;

        // 1_000_000_000 × (200 × 1e8) / 1e9 = 200 × 1e8
        assert.equal(usd8, 200n * 10n ** 8n);
        assert.equal(reads.length, 1);
        assert.equal(
            (reads[0] as string).toLowerCase(),
            (solUsd.address as string).toLowerCase(),
        );
    });

    it("usdValue(0 lamports, any adapter) == 0 usd8 but still records the read", async () => {
        const [usd8, reads]: [bigint, readonly string[]] = (await harness.read.usdValueWithReads([
            0n,
            solUsd.address,
            1n,
        ])) as any;
        assert.equal(usd8, 0n);
        // Even zero-value reads should be in the audit trail — the feed was
        // read (oracle call made), so the dependency is real.
        assert.equal(reads.length, 1);
    });

    // ──────────────────────────────────────────────────────────────────
    // evmGasUsd — gas × gasPriceWei × ethPriceE8 / 1e18 + audit trail
    // ──────────────────────────────────────────────────────────────────

    it("evmGasUsd(21000, 1 gwei, ETH/USD@$3500) matches spreadsheet", async () => {
        const gas = 21_000n;
        const gasPriceWei = 10n ** 9n; // 1 gwei
        const [usd8, reads]: [bigint, readonly string[]] = (await harness.read.evmGasUsdWithReads([
            gas,
            gasPriceWei,
            ethUsd.address,
            1n,
        ])) as any;

        // 21000 × 1e9 × (3500 × 1e8) / 1e18 = 21000 × 3500 × 1e-1 = 7_350_000 usd8
        // i.e. $0.07350000
        const expected = (gas * gasPriceWei * 3500n * 10n ** 8n) / 10n ** 18n;
        assert.equal(usd8, expected);
        assert.equal(reads.length, 1);
        assert.equal(
            (reads[0] as string).toLowerCase(),
            (ethUsd.address as string).toLowerCase(),
        );
    });

    // ──────────────────────────────────────────────────────────────────
    // Audit trail round-trip — usdValue + evmGasUsd + CostEstimate.oracleReads
    // ──────────────────────────────────────────────────────────────────

    it("CostEstimate.oracleReads contains exactly the two adapters in call order", async () => {
        const lamports = 1_000_000_000n;
        const gas = 21_000n;
        const gasPriceWei = 10n ** 9n;

        const e: any = await harness.read.quoteCostRoundTrip([
            lamports,
            gas,
            gasPriceWei,
            solUsd.address,
            ethUsd.address,
        ]);

        assert.equal(e.oracleReads.length, 2);
        assert.equal(
            (e.oracleReads[0] as string).toLowerCase(),
            (solUsd.address as string).toLowerCase(),
            "first oracle read should be the SOL/USD adapter (usdValue call)",
        );
        assert.equal(
            (e.oracleReads[1] as string).toLowerCase(),
            (ethUsd.address as string).toLowerCase(),
            "second oracle read should be the ETH/USD adapter (evmGasUsd call)",
        );

        // total should be sol_usd + gas_usd
        const solUsd8 = (lamports * SOL_USD_PRICE) / 10n ** 9n;
        const gasUsd8 = (gas * gasPriceWei * ETH_USD_PRICE) / 10n ** 18n;
        assert.equal(e.totalUserCostUsd, solUsd8 + gasUsd8);
    });

    // ──────────────────────────────────────────────────────────────────
    // Overflow — push past pre-sized capacity
    // ──────────────────────────────────────────────────────────────────

    it("pushRead reverts when capacity exceeded", async () => {
        await assert.rejects(
            async () => harness.read.overfillReads([solUsd.address, 1n]),
            (err: any) => String(err?.message ?? "").includes("reads overflow"),
        );
    });

    // ──────────────────────────────────────────────────────────────────
    // Negative-price guard
    // ──────────────────────────────────────────────────────────────────

    it("usdValue reverts on non-positive SOL price", async () => {
        const bad = await viem.deployContract("MockPriceAdapter", [0n]);
        await assert.rejects(
            async () =>
                harness.read.usdValueWithReads([100n, bad.address, 1n]),
            (err: any) => String(err?.message ?? "").includes("non-positive SOL price"),
        );
    });

    it("evmGasUsd reverts on non-positive ETH price", async () => {
        const bad = await viem.deployContract("MockPriceAdapter", [-1n]);
        await assert.rejects(
            async () =>
                harness.read.evmGasUsdWithReads([21_000n, 1n, bad.address, 1n]),
            (err: any) => String(err?.message ?? "").includes("non-positive ETH price"),
        );
    });
});
