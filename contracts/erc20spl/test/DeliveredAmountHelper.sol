// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Pure mirror of the delivered-amount arithmetic in both wrappers, so the two
/// directions and the fee cap can be asserted without a chain.
///
/// The wrappers MEASURE the delivered amount rather than computing it from
/// feeBps, because SPL caps the fee at maximum_fee — a bps computation is wrong
/// above the cap. `spl_fee` below exists only to demonstrate that, and is
/// deliberately not what the wrappers do.
library DeliveredAmountHelper {
    /// What the wrappers compute, given balances observed around the transfer.
    function delivered(
        bool feeArmed,
        bool selfTransfer,
        uint256 value,
        uint256 before,
        uint256 afterBal
    ) internal pure returns (uint256) {
        if (!feeArmed) {
            return value;
        }
        // Self-transfer nets minus the fee, so measure the loss instead; the
        // other direction would underflow.
        return selfTransfer ? value - (before - afterBal) : afterBal - before;
    }

    /// SPL's own rule: ceil(amount * bps / 10_000), capped at maximumFee.
    /// Present to show why the wrappers do not compute the fee themselves.
    function spl_fee(uint256 amount, uint16 bps, uint64 maximumFee) internal pure returns (uint256) {
        uint256 raw = (amount * bps + 9_999) / 10_000;
        return raw > maximumFee ? maximumFee : raw;
    }
}
