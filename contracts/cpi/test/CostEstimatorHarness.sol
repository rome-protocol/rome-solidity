// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CostEstimator} from "../CostEstimator.sol";
import {
    CostEstimate,
    RentRequirement,
    ProtocolFee,
    ExpectedOutput
} from "../CostEstimate.sol";

/// @dev Test-only harness exposing CostEstimator + simulating a full
///      adapter-side `quoteCost` call that exercises the oracleReads audit
///      trail.
contract CostEstimatorHarness {
    // ── rent helpers ──
    function rentForSpace(uint64 space) external pure returns (uint64) {
        return CostEstimator.rentForSpace(space);
    }
    function rentForAta() external pure returns (uint64) {
        return CostEstimator.rentForAta();
    }
    function SPL_TOKEN_ACCOUNT_RENT() external pure returns (uint64) {
        return CostEstimator.SPL_TOKEN_ACCOUNT_RENT;
    }
    function MINT_ACCOUNT_RENT() external pure returns (uint64) {
        return CostEstimator.MINT_ACCOUNT_RENT;
    }
    function ZERO_SPACE_RENT() external pure returns (uint64) {
        return CostEstimator.ZERO_SPACE_RENT;
    }
    function MULTISIG_RENT() external pure returns (uint64) {
        return CostEstimator.MULTISIG_RENT;
    }

    // ── rollup helper ──
    function sumLamportsRent(uint64[] memory lamports, bool[] memory alreadyExists)
        external
        pure
        returns (uint64)
    {
        RentRequirement[] memory rents = new RentRequirement[](lamports.length);
        for (uint256 i = 0; i < lamports.length; i++) {
            rents[i] = RentRequirement({
                accountPurpose: keccak256(abi.encode(i)),
                lamports: lamports[i],
                alreadyExists: alreadyExists[i]
            });
        }
        return CostEstimator.sumLamportsRent(rents);
    }

    // ── Single-shot usdValue (for unit tests) ──
    function usdValueWithReads(
        uint64 lamports,
        address solUsdAdapter,
        uint256 capacity
    ) external view returns (uint256 usd8, address[] memory reads) {
        CostEstimator.ReadsBuffer memory buf = CostEstimator.newReadsBuffer(capacity);
        usd8 = CostEstimator.usdValue(lamports, solUsdAdapter, buf);
        reads = CostEstimator.finalizeReads(buf);
    }

    function evmGasUsdWithReads(
        uint256 gas,
        uint256 gasPriceWei,
        address ethUsdAdapter,
        uint256 capacity
    ) external view returns (uint256 usd8, address[] memory reads) {
        CostEstimator.ReadsBuffer memory buf = CostEstimator.newReadsBuffer(capacity);
        usd8 = CostEstimator.evmGasUsd(gas, gasPriceWei, ethUsdAdapter, buf);
        reads = CostEstimator.finalizeReads(buf);
    }

    // ── Full audit-trail round-trip: simulates a synthetic adapter's quoteCost ──
    /// Calls usdValue, then evmGasUsd, rolls up into a CostEstimate with the
    /// two adapters appended to oracleReads in call order. Matches the
    /// "audit trail round-trip" case in cardo-foundation §7 Task 7 step 4.
    function quoteCostRoundTrip(
        uint64 lamports,
        uint256 gas,
        uint256 gasPriceWei,
        address solUsdAdapter,
        address ethUsdAdapter
    ) external view returns (CostEstimate memory e) {
        CostEstimator.ReadsBuffer memory buf = CostEstimator.newReadsBuffer(2);

        uint256 solUsd = CostEstimator.usdValue(lamports, solUsdAdapter, buf);
        uint256 gasUsd = CostEstimator.evmGasUsd(gas, gasPriceWei, ethUsdAdapter, buf);

        e.evmGasEstimate = gas;
        e.solanaCuEstimate = 0;
        e.rentRequired = new RentRequirement[](1);
        e.rentRequired[0] = RentRequirement({
            accountPurpose: bytes32(0),
            lamports: lamports,
            alreadyExists: false
        });
        e.fees = new ProtocolFee[](0);
        e.output = ExpectedOutput({tokenErc20Spl: address(0), expectedAmount: 0, minAmount: 0});
        e.totalUserCostUsd = solUsd + gasUsd;
        e.oracleReads = CostEstimator.finalizeReads(buf);
    }

    // ── Overflow case: allocate capacity N, push N+1 ──
    function overfillReads(address adapter, uint256 capacity) external pure {
        CostEstimator.ReadsBuffer memory buf = CostEstimator.newReadsBuffer(capacity);
        for (uint256 i = 0; i <= capacity; i++) {
            CostEstimator.pushRead(buf, adapter);
        }
    }
}
