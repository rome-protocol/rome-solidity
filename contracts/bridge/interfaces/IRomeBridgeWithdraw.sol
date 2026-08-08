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
///         Two egress flows are DELIBERATELY two transactions — the approve and
///         the move must not be combined (each Rome DoTx has a ~1.4M-CU budget,
///         and combining trips the iterative-VM `CpiProhibitedInIterativeTx`
///         gate). Both halves are listed here; see the per-function notes.
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

    // ─── CCTP (USDC) egress ──────────────────────────────────────────────────
    function burnUSDC(uint256 amount, address ethereumRecipient) external;
    function burnUSDC(uint256 amount, address recipient, uint32 destinationDomain) external;

    // ─── Wormhole — ETH egress (2-tx: approve, then burn) ────────────────────
    /// @notice Step 1 of 2. Must precede `burnETH` in a SEPARATE tx.
    function approveBurnETH(uint256 amount) external;
    /// @notice Step 2 of 2. Requires a prior `approveBurnETH` in an earlier tx.
    function burnETH(uint256 amount, address ethereumRecipient) external;

    // ─── Wormhole — generic asset egress (2-tx: approve, then move) ──────────
    /// @notice Step 1 of 2 for BOTH `burnToWormhole` and `transferNativeToWormhole`.
    ///         Delegates the Wormhole authority_signer PDA as burn delegate on the
    ///         caller's ATA. Must precede the move in a SEPARATE tx. Asset-neutral —
    ///         the same approval serves the wrapped and native paths.
    function approveWormholeBurn(address assetWrapper, uint256 amount) external;

    /// @notice Step 2 of 2 — transfer_wrapped path, for Wormhole-origin assets
    ///         (e.g. wETH). Requires a prior `approveWormholeBurn` in an earlier tx.
    /// @param  targetChain Wormhole chain id, PER-CALL (must be allowlisted).
    function burnToWormhole(
        address assetWrapper,
        uint256 amount,
        bytes32 recipient,
        uint16 targetChain
    ) external;

    /// @notice Step 2 of 2 — transfer_native path, for Solana-native mints
    ///         (wSOL, mSOL, LSTs). Requires a prior `approveWormholeBurn` in an
    ///         earlier tx. Tokens move into Token Bridge custody and a transfer
    ///         VAA is posted; the recipient redeems on the target chain.
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
