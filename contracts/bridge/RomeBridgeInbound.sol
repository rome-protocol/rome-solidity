// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {SPL_ERC20} from "../erc20spl/erc20spl.sol";
import {IUnwrapSplToGas, UnwrapSplToGas} from "../interface.sol";
import {RomeBridgeEvents} from "./RomeBridgeEvents.sol";

/// @title  RomeBridgeInbound
/// @notice Replaces the Solana-side `settle_inbound_bridge` rome-evm-private
///         instruction with a Solidity contract the worker calls via the
///         existing `do_tx` instruction (operator-signed, fee_addr=operator
///         so the user pays zero Rome gas).
///
/// @dev    ## Flow
///         1. CCTP receiveMessage / Wormhole redeem mints `total` rUSDC to
///            user's PDA-owned ATA (unchanged — happens on Solana side).
///         2. User signs one EVM tx calling `settleInbound(wrapperAmount)`.
///         3. Worker submits the tx via `do_tx(fee_addr=operator, rlp)` —
///            operator pays Rome gas; user pays nothing.
///         4. `settleInbound`:
///              - Pulls `wrapperAmount` rUSDC from user's ATA into this
///                contract's ATA via `SPL_ERC20.transferFrom`.
///              - Calls `unwrap_spl_to_gas(gasAmountWei)` — wrapper balance
///                in this contract's ATA becomes gas in this contract's
///                Balance PDA. The precompile reads `msg.sender`, which
///                from its point of view is this contract.
///              - Forwards the just-minted gas to the user via a native
///                `user.call{value: gasAmountWei}("")`. This debits this
///                contract's Balance PDA and credits the user's.
///              - Emits `SettledInbound`.
///
///         ## Allowance requirement
///         User must have previously approved `this` on the SPL_ERC20
///         wrapper for at least `wrapperAmount`. In the typical inbound
///         bridge UX this is a second do_tx(fee_addr=operator) submission
///         that happens right before settleInbound in the same worker pass.
///
///         ## Why this contract instead of the on-chain instruction
///         The rome-evm-private `settle_inbound_bridge` instruction
///         expects an RLP-encoded signed EVM tx carried in the Solana ix,
///         which would require `eth_signTransaction` on the client —
///         MetaMask blocks that. Routing through a regular Solidity
///         contract call via `do_tx` keeps the UX as standard
///         `writeContractAsync` on whatever wallet the user has.
///
///         ## Why not just `user.call(unwrap_spl_to_gas)` directly
///         `unwrap_spl_to_gas` reads `msg.sender` and unwraps the CALLER's
///         wrapper balance into the CALLER's gas balance. If we want to
///         atomically record events / enforce invariants / emit structured
///         audit data, we need a contract wrapper. This is it.
contract RomeBridgeInbound is ERC2771Context, RomeBridgeEvents {
    /// @notice ERC20-SPL wrapper for the chain's gas mint (e.g. rUSDC on Marcus).
    SPL_ERC20 public immutable wrapper;

    /// @notice Chain's gas mint (bytes32 pubkey) — recorded in SettledInbound
    ///         so indexers don't need to re-read from the wrapper contract.
    bytes32 public immutable mint;

    /// @notice Wrapper-to-wei scale factor — 10^(18 - mint_decimals).
    ///         USDC (6-dec) → 10^12. SPL_ERC20 exposes `decimals()` at
    ///         construction time; frozen here to save a SLOAD per call.
    uint256 public immutable scaleWeiPerUnit;

    /// @dev Insufficient wrapper allowance set by the user for this contract.
    error InsufficientAllowance(address user, uint256 needed, uint256 have);

    /// @dev Insufficient wrapper balance in the user's ATA.
    error InsufficientBalance(address user, uint256 needed, uint256 have);

    /// @dev Forward of unwrapped gas to the user failed. Never expected
    ///      in practice — reverts the whole settlement so the wrapper
    ///      stays in this contract's ATA (reconcilable by operator).
    error GasForwardFailed(address user, uint256 gasAmountWei);

    /// @dev Zero-amount settlement is a caller bug; fail loud instead of
    ///      silently emitting a no-op event.
    error ZeroAmount();

    constructor(
        address forwarder,
        SPL_ERC20 wrapper_,
        bytes32 mint_
    ) ERC2771Context(forwarder) {
        wrapper = wrapper_;
        mint = mint_;

        uint8 dec = wrapper_.decimals();
        require(dec <= 18, "decimals>18 unsupported");
        unchecked {
            // 10^(18 - dec) — overflow-safe since 18 - dec <= 18.
            scaleWeiPerUnit = 10 ** (18 - dec);
        }
    }

    /// @notice Convert `wrapperAmount` of the user's rUSDC into native Rome
    ///         gas, crediting the user's Balance PDA.
    /// @param  wrapperAmount Mint-unit tokens to convert (e.g. for USDC with
    ///                       6 decimals, `1_000_000` = 1 USDC).
    /// @return gasAmountWei  Wei the user received.
    function settleInbound(uint256 wrapperAmount)
        external
        returns (uint256 gasAmountWei)
    {
        if (wrapperAmount == 0) revert ZeroAmount();

        address user = _msgSender();

        // Preflight: surface decoded errors before the transferFrom CPI
        // mangles the revert path. Both checks are strictly-LT so a gas
        // race between two settle calls gets a readable message.
        uint256 balance = wrapper.balanceOf(user);
        if (balance < wrapperAmount) {
            revert InsufficientBalance(user, wrapperAmount, balance);
        }
        uint256 allowed = wrapper.allowance(user, address(this));
        if (allowed < wrapperAmount) {
            revert InsufficientAllowance(user, wrapperAmount, allowed);
        }

        // 1. Pull wrapper from user's ATA into this contract's ATA.
        //    SPL_ERC20.transferFrom returns bool per IERC20 spec; a `false`
        //    return would indicate SPL CPI trouble — the wrapper reverts
        //    internally in that case, so we treat `false` as a defensive
        //    catch-all rather than a realistic path.
        require(
            wrapper.transferFrom(user, address(this), wrapperAmount),
            "transferFrom"
        );

        // 2. Unwrap this contract's wrapper balance into this contract's
        //    Balance PDA. The precompile requires wei to be a multiple of
        //    scaleWeiPerUnit; multiplying by scaleWeiPerUnit guarantees that.
        gasAmountWei = wrapperAmount * scaleWeiPerUnit;
        UnwrapSplToGas.unwrap_spl_to_gas(gasAmountWei);

        // 3. Forward to the user. `call{value}` uses msg.value semantics
        //    which on Rome EVM = a Balance PDA transfer. If it fails the
        //    whole tx reverts and the wrapper goes back to the user's ATA
        //    (atomicity). An operator can re-sweep the contract's wrapper
        //    after investigation if this ever triggers.
        (bool ok, ) = payable(user).call{value: gasAmountWei}("");
        if (!ok) revert GasForwardFailed(user, gasAmountWei);

        emit SettledInbound(user, mint, wrapperAmount, gasAmountWei);
    }

    /// @notice Receive-ether hook so the contract can hold its own Balance
    ///         PDA temporarily between unwrap and forward. Without this the
    ///         precompile's credit would revert.
    receive() external payable {}
}
