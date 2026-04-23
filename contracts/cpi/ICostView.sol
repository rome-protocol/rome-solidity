// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CostEstimate} from "./CostEstimate.sol";

/// @title ICostView — quote interface every Cardo adapter implements.
/// @dev Per cardo-foundation.md §4.2.
///
///      Capability multiplexing: for adapters with multiple capabilities
///      (Kamino deposit/withdraw/borrow/repay, Drift place/cancel/settle) the
///      selector is encoded inside `capabilityInputs`:
///
///        function quoteCost(address user, bytes calldata capabilityInputs)
///            external view override returns (CostEstimate memory e)
///        {
///            (bytes4 selector, bytes memory args) =
///                abi.decode(capabilityInputs, (bytes4, bytes));
///            if (selector == this.deposit.selector) return _quoteDeposit(user, args);
///            if (selector == this.withdraw.selector) return _quoteWithdraw(user, args);
///            ...
///            revert UnknownCapability(selector);
///        }
///
///      Single-capability adapters (e.g. Meteora) can ignore the selector
///      convention and decode `capabilityInputs` directly. Either way, the
///      interface is one method across all Cardo apps — Cardo UI can render
///      the rollup without app-specific code paths.
interface ICostView {
    /// Quote the cost of a capability. `capabilityInputs` is the encoded
    /// tuple the adapter's write method would take. Pure / view; safe to
    /// call in the Cardo UI before the user signs.
    function quoteCost(address user, bytes calldata capabilityInputs)
        external
        view
        returns (CostEstimate memory);
}
