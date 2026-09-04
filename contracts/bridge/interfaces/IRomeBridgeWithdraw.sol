// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IRomeBridgeWithdraw
/// @notice Discovery interface for the Rome bridge egress contract.
/// @dev    Deployed per-chain; the address is canonical in `rome-protocol/registry`
///         and is NEVER hardcoded here. Composers import this type and construct it
///         with a registry-sourced address (type from code, address from data).
///         Implementation: `contracts/bridge/RomeBridgeWithdraw.sol`.
///
///         ADMISSION RULE — what belongs in this file:
///           • every externally callable state-mutating entry point;
///           • the views needed to precondition or track those flows;
///           • every error those paths revert with.
///         Excluded: per-chain config-address getters (address-from-data doctrine —
///         they are registry data, not call surface), and the bridge lifecycle
///         events, which stay canonical in `contracts/bridge/RomeBridgeEvents.sol`.
///
///         Every mutating call here is a direct CALL, never a DELEGATECALL —
///         the rome-evm program refuses DELEGATECALL into a mutating
///         precompile, so the bridge signs every Solana side effect as
///         itself. Callers grant it an SPL delegate on their own ATA once,
///         off-contract (`approve_spl(bridge, …)` sent directly to 0xff..09)
///         before any egress call.
interface IRomeBridgeWithdraw {
    // ─── Events ──────────────────────────────────────────────────────────────
    // Admin only. Bridge lifecycle events (Withdrawn, WormholeBurn,
    // BridgedOutToSolana, …) are canonical in RomeBridgeEvents.sol.
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event WormholeAssetAllowedSet(address indexed assetWrapper, bool allowed);
    event WormholeTargetChainAllowedSet(uint16 indexed targetChain, bool allowed);

    // ─── Errors ──────────────────────────────────────────────────────────────
    error AmountExceedsUint64(uint256 amount);
    error InsufficientBalance(address user, uint256 requested, uint256 available);
    error CpiFailed(bytes reason);
    error UnsupportedDestinationDomain(uint32 domain);
    error DomainConfigLengthMismatch();
    error ZeroRecipient();
    error UnsupportedTargetChain(uint16 targetChain);
    error UnsupportedAssetWrapper(address assetWrapper);
    error NotOwner(address caller);
    error ZeroOwner();
    error SubGranularityAmount(uint256 amount, uint256 granularity);

    // ─── CCTP (USDC) egress ──────────────────────────────────────────────────
    function burnUSDC(uint256 amount, address ethereumRecipient) external;
    function burnUSDC(uint256 amount, address recipient, uint32 destinationDomain) external;

    // ─── Wormhole — ETH egress ────────────────────────────────────────────────
    /// @notice Requires the caller to have granted the bridge an SPL delegate
    ///         on their wETH ATA beforehand (`approve_spl(bridge, …)` sent
    ///         directly to 0xff..09).
    function burnETH(uint256 amount, address ethereumRecipient) external;

    // ─── Wormhole — generic asset egress ─────────────────────────────────────
    /// @notice transfer_wrapped path, for Wormhole-origin assets (e.g. wETH).
    ///         Requires the caller to have granted the bridge an SPL delegate
    ///         on their ATA for `assetWrapper`'s mint beforehand.
    /// @param  targetChain Wormhole chain id, PER-CALL (must be allowlisted).
    function burnToWormhole(
        address assetWrapper,
        uint256 amount,
        bytes32 recipient,
        uint16 targetChain
    ) external;

    /// @notice transfer_native path, for Solana-native mints (wSOL, mSOL,
    ///         LSTs). Requires the same prior delegate as `burnToWormhole`.
    ///         Tokens move into Token Bridge custody and a transfer VAA is
    ///         posted; the recipient redeems on the target chain.
    /// @param  targetChain Wormhole chain id, PER-CALL (must be allowlisted).
    function transferNativeToWormhole(
        address assetWrapper,
        uint256 amount,
        bytes32 recipient,
        uint16 targetChain
    ) external;

    // ─── Solana-native egress (2-tx: ensure ATA, then transfer) ──────────────
    /// @notice Step 1 of 2. Idempotently creates the recipient's ATA for `mint`
    ///         so a subsequent `bridgeOutToSolana` lands. Separate tx by design.
    function ensureRecipientAta(bytes32 solanaRecipient, bytes32 mint) external;

    /// @notice Deploy-time, per-mint bootstrap: idempotently creates the
    ///         bridge's own ATA for `mint`. Every mint the bridge egresses
    ///         needs this run once before its first burn — the pull leg has
    ///         no create fallback.
    function ensureBridgeAta(bytes32 mint) external;

    /// @notice Step 2 of 2. Transfer-only Rome → Solana egress of a held SPL
    ///         wrapper. The destination ATA MUST already exist — SPL
    ///         transfer_checked does not create it, so call `ensureRecipientAta`
    ///         first when uncertain.
    function bridgeOutToSolana(
        bytes32 solanaRecipient,
        uint256 amount,
        bytes32 mint
    ) external;

    // ─── Admin / config ──────────────────────────────────────────────────────
    function setWormholeAssetAllowed(address assetWrapper, bool allowed) external;
    function setWormholeTargetChainAllowed(uint16 targetChain, bool allowed) external;
    function transferOwnership(address newOwner) external;

    // ─── Views — preconditions and flow state ────────────────────────────────
    function owner() external view returns (address);
    /// @notice Allow-list check keyed by WRAPPER address (resolves the mint internally).
    function wormholeAssetAllowed(address assetWrapper) external view returns (bool);
    /// @notice Allow-list check keyed by SPL MINT — the storage the egress paths gate on.
    function wormholeMintAllowed(bytes32 mint) external view returns (bool);
    function wormholeTargetChainAllowed(uint16 targetChain) external view returns (bool);
    /// @notice Per-user egress counter; lets a caller correlate emitted events.
    function burnNonce(address user) external view returns (uint64);
}
