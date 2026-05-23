// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {HelperProgram} from "../interface.sol";

/// @dev Minimal wrapper view used by the demo contracts. Bound at the
///      SPL_ERC20_cached wrapper's address so the cache-track mutations
///      it dispatches fire as if a regular consumer called them.
interface IWrapperLite {
    function transfer(address to, uint256 value) external returns (bool);
}

/// @title  CachedRevertDemo
/// @notice Demonstrator for the cache track's defining property — EVM
///         revert atomicity over Solana side effects. Calls the wrapper's
///         cache-based transfer, then explicitly reverts. Expected:
///         recipient's SPL balance is UNCHANGED post-tx because the
///         cache overlay discards the queued instruction on EVM revert.
///         Contrast with the CPI-based SPL_ERC20 wrapper where the SPL
///         transfer would already have hit Solana before the revert.
contract CachedRevertDemo {
    /// @notice Transfer then revert. Outer call MUST revert; recipient
    ///         balance MUST be unchanged after the tx.
    function transferThenRevert(
        address wrapper,
        address to,
        uint256 value
    ) external {
        IWrapperLite(wrapper).transfer(to, value);
        revert("intentional revert - transfer must be unwound");
    }
}

/// @title  IterativeMultiTransferDemo
/// @notice Demonstrator for the cache track's iterative-VM unlock. Burns
///         enough EVM CU to push the tx into iterative VM, then performs
///         N cache-based wrapper.transfer calls. On the CPI track this
///         pattern hits CpiProhibitedInIterativeTx after the first
///         transfer. On cache, all N succeed because cache Invoke is
///         iterative-VM-compatible.
contract IterativeMultiTransferDemo {
    uint256 public counter;

    /// @notice Burns EVM CU then performs N transfers. Each Solana tx in
    ///         the iterative sequence has its own 1.4M CU budget; the
    ///         cache commit fires `invoke_signed` at end-of-tx.
    function burnAndTransferN(
        address wrapper,
        address[] calldata recipients,
        uint256 amountEach
    ) external {
        // Bump EVM CU past the atomic-VM threshold so the rome-evm
        // iterative VM kicks in. The exact loop count is empirical —
        // 5_000 SSTOREs comfortably exceeds the atomic-VM gas envelope
        // on every chain configuration this contract is deployed on.
        for (uint256 i = 0; i < 5_000; i++) {
            counter = counter + 1;
        }
        for (uint256 i = 0; i < recipients.length; i++) {
            IWrapperLite(wrapper).transfer(recipients[i], amountEach);
        }
    }
}

/// @title  OrderingViolationDemo
/// @notice Documents the in-tx ordering rule consumers must respect:
///         CPI CrossStateEthCall reads (e.g., HelperProgram.user_balance)
///         that follow a cache Invoke in the same tx are blocked by
///         verify_call. The expected outcome is a revert at the second
///         call site with NonEvmCallError("attempt to use cpi-cached
///         program with cpi-program").
contract OrderingViolationDemo {
    /// @notice Cache mutation -> CPI CrossStateEthCall. Reverts.
    function cacheThenReadFromCpi(
        address wrapper,
        address to,
        uint256 value,
        address probeUser,
        bytes32 probeMint
    ) external returns (uint64) {
        IWrapperLite(wrapper).transfer(to, value);
        return HelperProgram.user_balance(probeUser, probeMint);
    }
}
