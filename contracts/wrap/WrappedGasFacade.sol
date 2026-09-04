// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interface.sol";

interface IWrapperMintInfo {
    function decimals() external view returns (uint8);
    function mint_id() external view returns (bytes32);
}

/// @title WrappedGasFacade — WETH9-shaped surface over the gas-wrapper precompiles
/// @notice `deposit()` wraps native gas into the chain's gas mint; `withdraw(uint256)`
///         unwraps back to native gas. Both emit the canonical WETH9
///         `Deposit`/`Withdrawal` events, so explorers, indexers and eth_getLogs
///         consumers see gas-wrapper movements without special-casing — the raw
///         precompile legs leave no EVM footprint of their own.
///
///         Moves the underlying SPL straight to/from each caller's own ATA by direct
///         CALL, never through the wrapper token's ERC-20 surface: `wrapper` only
///         pins decimals + mint identity, since `wrapper.balanceOf` reads that same
///         on-chain ATA for an EOA. `withdraw`'s precondition is therefore an
///         SPL-level `approve_spl(facade, tokens, mint)` grant from the caller's own
///         EOA to `0xff..09`, not an ERC-20 `wrapper.approve`. A contract-composed
///         caller has no ATA of its own for the wrapper's escrow ledger to observe
///         and is out of scope here — that path needs a wrapper-side entry point.
///
///         Cached track only (one-track rule): `WithdrawCached` (0xff..0b),
///         `SplCached` (0xff..05), `HelperProgram` (0xff..09).
contract WrappedGasFacade {
    IWrapperMintInfo public immutable wrapper;
    bytes32 public immutable mintId;
    /// @notice Native wei per one raw SPL unit: 10^(18 - wrapper.decimals()).
    ///         Amounts below this granularity cannot be represented.
    uint256 public immutable weiPerToken;

    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    error Granularity();
    error NativeSendFailed();
    error MintMismatch();

    constructor(IWrapperMintInfo _wrapper) {
        uint8 decimals = _wrapper.decimals();
        require(decimals <= 18, "decimals");
        bytes32 gasMint = SystemProgram.mint_id();
        if (_wrapper.mint_id() != gasMint) revert MintMismatch();
        wrapper = _wrapper;
        mintId = gasMint;
        weiPerToken = 10 ** (18 - decimals);
    }

    /// @notice Idempotent one-time bootstrap: create the facade's gas-mint ATA.
    ///         Run once after deploy, before the first `deposit()` or `withdraw()`.
    ///         The wrap precompile's internal auto-create path cannot be relied on
    ///         (unsupported in emulation), and `withdraw()`'s pull leg needs the
    ///         destination ATA to already exist — explicit creation makes the
    ///         facade order-independent.
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

        // Wrap leg: facade's native wei -> SPL in the facade's own PDA-owned ATA
        // (precompile auto-creates it if missing) -> caller's own ATA, direct.
        WithdrawCached.withdraw_to_ata(wad);
        SplCached.transfer(msg.sender, wad / weiPerToken);

        uint256 dust = msg.value - wad;
        if (dust > 0) {
            (bool refunded, ) = payable(msg.sender).call{value: dust}("");
            if (!refunded) revert NativeSendFailed();
        }
        emit Deposit(msg.sender, wad);
    }

    /// @notice Unwrap back to native gas. Requires a prior
    ///         `approve_spl(address(this), wad / weiPerToken, mintId)` call to
    ///         `0xff..09` from the caller's own EOA — an SPL-level delegate grant,
    ///         not an ERC-20 `wrapper.approve`.
    /// @param wad Native-wei amount; must be a whole multiple of `weiPerToken`.
    function withdraw(uint256 wad) external {
        if (wad == 0 || wad % weiPerToken != 0) revert Granularity();

        // Unwrap leg: caller's own ATA -> facade's own ATA (facade signs as the
        // caller's delegate) -> native credit to the facade, forwarded on.
        HelperProgram.transfer_spl(
            HelperProgram.ata(msg.sender, mintId),
            HelperProgram.ata(address(this), mintId),
            uint64(wad / weiPerToken),
            mintId
        );
        WithdrawCached.deposit(wad);
        (bool sent, ) = payable(msg.sender).call{value: wad}("");
        if (!sent) revert NativeSendFailed();

        emit Withdrawal(msg.sender, wad);
    }
}
