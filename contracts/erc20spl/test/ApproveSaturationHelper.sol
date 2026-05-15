// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Mirror of the saturation + sentinel arithmetic used in SPL_ERC20.approve
/// and SPL_ERC20.allowance. Pure functions so this is testable on
/// hardhat-network without the SPL CPI roundtrip.
///
/// SPL Token stores `delegated_amount` as a u64 on-chain. The wrapper's
/// public ERC20 surface speaks `uint256`. When the caller passes a value
/// that exceeds u64::MAX we MUST saturate at u64::MAX (truncating would
/// silently corrupt the on-chain delegation). At read time we surface a
/// saturated storage cell as `type(uint256).max` so the common wallet
/// pattern `if allowance == MaxUint256` keeps recognizing infinite
/// approvals.
contract ApproveSaturationHelper {
    /// @notice The arithmetic SPL_ERC20.approve uses to derive (stored_u64, emitted_uint256).
    function saturateApproval(uint256 value) external pure returns (uint64 stored, uint256 emitted) {
        stored = value > type(uint64).max ? type(uint64).max : uint64(value);
        emitted = stored == type(uint64).max ? type(uint256).max : uint256(stored);
    }

    /// @notice The arithmetic SPL_ERC20.allowance uses to surface the u64 delegated_amount as uint256.
    function readAllowance(uint64 delegated) external pure returns (uint256) {
        return delegated == type(uint64).max ? type(uint256).max : uint256(delegated);
    }
}
