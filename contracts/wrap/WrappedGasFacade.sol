// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interface.sol";

interface IERC20Minimal {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function decimals() external view returns (uint8);
}

/// @title WrappedGasFacade — WETH9-shaped surface over the gas-wrapper precompiles
/// @notice `deposit()` wraps native gas into the chain's gas-mint wrapper token;
///         `withdraw(uint256)` unwraps back to native gas. Both emit the canonical
///         WETH9 `Deposit`/`Withdrawal` events, so explorers, indexers and
///         eth_getLogs consumers see gas-wrapper movements without special-casing —
///         the raw precompile legs (`withdraw_to_ata` / `deposit`) leave no EVM
///         footprint (no logs, no value).
///
///         Custody pools under the facade's own authority, exactly as WETH9 pools
///         ETH: the wrap leg lands wrapper tokens in the facade's PDA-owned ATA
///         (auto-created by the precompile on first use), which the facade then
///         transfers out to the caller; the unwrap leg pulls the caller's wrapper
///         tokens in (ERC-20 `approve` required — the wrapper is an external token,
///         not an internal ledger) and converts them to native credit forwarded on.
///
///         Cached track only (one-track rule): `WithdrawCached` (0xff..0b) plus the
///         cached wrapper's ERC-20 surface.
contract WrappedGasFacade {
    IERC20Minimal public immutable wrapper;
    /// @notice Native wei per one raw wrapper token unit: 10^(18 - wrapper.decimals()).
    ///         Amounts below this granularity cannot be represented in the wrapper.
    uint256 public immutable weiPerToken;

    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    error Granularity();
    error NativeSendFailed();

    constructor(IERC20Minimal _wrapper) {
        uint8 decimals = _wrapper.decimals();
        require(decimals <= 18, "decimals");
        wrapper = _wrapper;
        weiPerToken = 10 ** (18 - decimals);
    }

    /// @notice Idempotent one-time bootstrap: create the facade's gas-mint ATA.
    ///         Run once after deploy, before the first `deposit()`. The wrap
    ///         precompile's internal auto-create path cannot be relied on
    ///         (unsupported in emulation), and `withdraw()`'s pull leg only
    ///         creates the ATA as a side effect of the wrapper transfer —
    ///         explicit creation makes the facade order-independent.
    function ensureAta() external {
        AssociatedSplCached.create_ata();
    }

    /// @notice Wrap native gas into wrapper tokens. Sub-token dust is refunded.
    function deposit() external payable {
        _deposit();
    }

    /// @notice WETH9 equivalence: a plain native transfer wraps.
    receive() external payable {
        _deposit();
    }

    function _deposit() private {
        uint256 wad = msg.value - (msg.value % weiPerToken);
        if (wad == 0) revert Granularity();

        // Wrap leg: facade's native wei -> wrapper SPL in the facade's PDA-owned
        // ATA (precompile auto-creates the ATA if missing), then hand the tokens
        // to the caller through the wrapper's standard ERC-20 surface.
        WithdrawCached.withdraw_to_ata(wad);
        require(wrapper.transfer(msg.sender, wad / weiPerToken), "transfer");

        uint256 dust = msg.value - wad;
        if (dust > 0) {
            (bool refunded, ) = payable(msg.sender).call{value: dust}("");
            if (!refunded) revert NativeSendFailed();
        }
        emit Deposit(msg.sender, wad);
    }

    /// @notice Unwrap wrapper tokens back to native gas. Requires prior ERC-20
    ///         `approve` of `wad / weiPerToken` raw tokens to this contract.
    /// @param wad Native-wei amount; must be a whole multiple of `weiPerToken`.
    function withdraw(uint256 wad) external {
        if (wad == 0 || wad % weiPerToken != 0) revert Granularity();

        require(wrapper.transferFrom(msg.sender, address(this), wad / weiPerToken), "pull");
        // Unwrap leg: wrapper SPL in the facade's ATA -> native credit to the
        // facade, forwarded to the caller.
        WithdrawCached.deposit(wad);
        (bool sent, ) = payable(msg.sender).call{value: wad}("");
        if (!sent) revert NativeSendFailed();

        emit Withdrawal(msg.sender, wad);
    }
}
