// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAggregatorV3Interface} from "../oracle/IAggregatorV3Interface.sol";
import {Cpi} from "./Cpi.sol";
import {
    CostEstimate,
    RentRequirement,
    ProtocolFee,
    ExpectedOutput
} from "./CostEstimate.sol";

/// @title CostEstimator — rent, USD, and ATA-existence helpers for Cardo quoteCost.
/// @dev Per cardo-foundation.md §4.3.
///
///      USD precision: `uint256 usd8` = 1e8 scale (Chainlink / Oracle
///      Gateway V2 convention). Zero conversion rounding on oracle reads.
///
///      Audit trail: every oracle-reading helper takes a caller-supplied
///      `ReadsBuffer memory reads` and appends the adapter address it
///      consulted. Adapters pre-size the buffer in `quoteCost` and finalise
///      into `CostEstimate.oracleReads` via `finalizeReads`.
library CostEstimator {
    // ──────────────────────────────────────────────────────────────────
    // Solana rent constants (genesis-baked; never change on mainnet-beta)
    // ──────────────────────────────────────────────────────────────────

    uint64 internal constant ACCOUNT_STORAGE_OVERHEAD = 128;
    uint64 internal constant LAMPORTS_PER_BYTE_YEAR = 3480;
    uint64 internal constant EXEMPTION_THRESHOLD_YEARS = 2;

    /// Pre-tabulated common cases (match Solana on-chain rent exactly —
    /// each equals `(128 + space) * 6960` per the canonical formula).
    uint64 internal constant SPL_TOKEN_ACCOUNT_RENT = 2_039_280; // space=165
    uint64 internal constant MINT_ACCOUNT_RENT = 1_461_600;      // space=82
    /// space=355. Spec text (cardo-foundation §4.3) listed 2_477_760; that
    /// value is inconsistent with (128+355)*6960 = 3_361_680. Constant is
    /// set to the formula-exact value so the (128+space)*6960 invariant
    /// holds across every constant in the table.
    uint64 internal constant MULTISIG_RENT = 3_361_680;
    uint64 internal constant ZERO_SPACE_RENT = 890_880;          // space=0 stubs

    // ──────────────────────────────────────────────────────────────────
    // Oracle reads buffer — mutable append log used by every USD helper.
    //
    // Memory arrays in Solidity are fixed-size at allocation. The buffer
    // wraps a pre-sized `entries` array + a `len` counter so helpers can
    // append O(1) without copying. Call `finalizeReads(b)` to return the
    // sub-sliced `address[]` for CostEstimate.oracleReads.
    // ──────────────────────────────────────────────────────────────────

    struct ReadsBuffer {
        address[] entries;
        uint256 len;
    }

    /// Pre-size the buffer. `capacity` is the upper bound on oracle reads
    /// the quote will make — one per adapter consulted.
    function newReadsBuffer(uint256 capacity) internal pure returns (ReadsBuffer memory b) {
        b.entries = new address[](capacity);
        b.len = 0;
    }

    /// Append an adapter address. Reverts on overflow of the pre-sized
    /// capacity — the capacity mismatch is a programming error, not a
    /// runtime condition.
    function pushRead(ReadsBuffer memory b, address adapter) internal pure {
        require(b.len < b.entries.length, "CostEstimator: reads overflow");
        b.entries[b.len] = adapter;
        b.len += 1;
    }

    /// Finalise into a length-correct `address[]` for `CostEstimate.oracleReads`.
    function finalizeReads(ReadsBuffer memory b) internal pure returns (address[] memory out) {
        if (b.len == b.entries.length) {
            return b.entries;
        }
        out = new address[](b.len);
        for (uint256 i = 0; i < b.len; i++) {
            out[i] = b.entries[i];
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // Rent
    // ──────────────────────────────────────────────────────────────────

    /// Canonical Solana rent-exempt formula:
    ///   (128 + space) × 3480 × 2 = (128 + space) × 6960
    function rentForSpace(uint64 space) internal pure returns (uint64) {
        return (ACCOUNT_STORAGE_OVERHEAD + space) * LAMPORTS_PER_BYTE_YEAR * EXEMPTION_THRESHOLD_YEARS;
    }

    /// SPL Token ATA rent = rentForSpace(165). Constant for readability.
    function rentForAta() internal pure returns (uint64) {
        return SPL_TOKEN_ACCOUNT_RENT;
    }

    // ──────────────────────────────────────────────────────────────────
    // Existence checks — live account_info reads via CPI precompile
    // ──────────────────────────────────────────────────────────────────

    /// True if the account at `pubkey` has a nonzero lamport balance
    /// (proxy for "rent is already paid / account exists").
    function pdaExists(bytes32 pubkey) internal view returns (bool) {
        (uint64 lamports, , , , , ) = Cpi.accountInfo(pubkey);
        return lamports > 0;
    }

    /// True if the user's ATA (caller-supplied pubkey) already holds rent.
    /// Convenience alias for `pdaExists` — same mechanism, more legible at
    /// the adapter site.
    function ataExists(bytes32 ata) internal view returns (bool) {
        return pdaExists(ata);
    }

    // ──────────────────────────────────────────────────────────────────
    // USD helpers — read Oracle Gateway V2 adapters + append to audit trail
    // ──────────────────────────────────────────────────────────────────

    /// Convert lamports → USD at 1e8 scale.
    ///   usd8 = lamports × solUsdPriceE8 / 1e9
    /// Appends `solUsdAdapter` to the caller's oracle-reads audit trail.
    function usdValue(uint64 lamports, address solUsdAdapter, ReadsBuffer memory reads)
        internal
        view
        returns (uint256 usd8)
    {
        int256 price = _readPriceE8(solUsdAdapter);
        require(price > 0, "CostEstimator: non-positive SOL price");
        // SOL has 9 decimals → lamports are 1e9; oracle is 1e8 → output 1e8.
        usd8 = (uint256(lamports) * uint256(price)) / 1e9;
        pushRead(reads, solUsdAdapter);
    }

    /// Convert EVM gas × gasPrice → USD at 1e8 scale.
    ///   usd8 = gas × gasPriceWei × ethUsdPriceE8 / 1e18
    /// Appends `ethUsdAdapter` to the caller's audit trail.
    function evmGasUsd(
        uint256 gas,
        uint256 gasPriceWei,
        address ethUsdAdapter,
        ReadsBuffer memory reads
    ) internal view returns (uint256 usd8) {
        int256 price = _readPriceE8(ethUsdAdapter);
        require(price > 0, "CostEstimator: non-positive ETH price");
        // wei × priceE8 / 1e18 → usd8
        usd8 = (gas * gasPriceWei * uint256(price)) / 1e18;
        pushRead(reads, ethUsdAdapter);
    }

    // ──────────────────────────────────────────────────────────────────
    // Rollup
    // ──────────────────────────────────────────────────────────────────

    /// Compute `totalUserCostUsd` from the capability's populated fields.
    /// Gas USD + Solana CU rent (priced indirectly via rent_required
    /// lamports; CU compute-unit pricing stays at the adapter) +
    /// protocol fees (when fees[].amountIn + USD adapter known) +
    /// user-side slippage delta (output.expectedAmount - output.minAmount,
    /// in output-token USD via caller-specified adapter).
    ///
    /// This is an **adapter-side rollup**: the adapter assembles the
    /// individual pieces via the other helpers, then sums. Kept as a
    /// helper so the contract logic stays in the library.
    function sumLamportsRent(RentRequirement[] memory rents) internal pure returns (uint64 total) {
        for (uint256 i = 0; i < rents.length; i++) {
            if (!rents[i].alreadyExists) {
                total += rents[i].lamports;
            }
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // Internal — Chainlink-compat adapter read
    // ──────────────────────────────────────────────────────────────────

    function _readPriceE8(address adapter) private view returns (int256) {
        (, int256 answer, , , ) = IAggregatorV3Interface(adapter).latestRoundData();
        return answer;
    }
}
