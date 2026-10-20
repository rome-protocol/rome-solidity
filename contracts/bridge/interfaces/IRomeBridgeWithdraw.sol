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
    /// @notice The outbound rails that can be paused one at a time.
    enum Rail { CCTP, WORMHOLE, TO_SOLANA }

    // ─── Events ──────────────────────────────────────────────────────────────
    // Admin only. Bridge lifecycle events (Withdrawn, WormholeBurn,
    // BridgedOutToSolana, …) are canonical in RomeBridgeEvents.sol.
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event GuardianSet(address indexed previousGuardian, address indexed newGuardian);
    event CctpDomainEnabled(
        uint32 indexed domain,
        uint8 recipientKind,
        bytes32 remoteTokenMessengerPda,
        bytes32 circleMessenger
    );
    event CctpDomainDisabled(uint32 indexed domain, address indexed by);
    event RailPausedSet(Rail indexed rail, address indexed by);
    event RailUnpausedSet(Rail indexed rail, address indexed by);
    event WormholeAssetAllowedSet(address indexed assetWrapper, bool allowed);
    event WormholeTargetChainAllowedSet(uint16 indexed targetChain, bool allowed);

    // ─── Errors ──────────────────────────────────────────────────────────────
    error AmountExceedsUint64(uint256 amount);
    error InsufficientBalance(address user, uint256 requested, uint256 available);
    error CpiFailed(bytes reason);
    error UnsupportedDestinationDomain(uint32 domain);
    error ZeroRecipient();
    error UnsupportedTargetChain(uint16 targetChain);
    error UnsupportedAssetWrapper(address assetWrapper);
    error NotOwner(address caller);
    error NotOwnerOrGuardian(address caller);
    error NotPendingOwner(address caller);
    error RailPaused(Rail rail);
    error RailNotPaused(Rail rail);
    error InvalidRecipientKind(uint8 kind);
    error RecipientKindMismatch(uint32 domain, uint8 domainKind, uint8 requiredKind);
    error CctpDomainNotEnabled(uint32 domain);
    error InvalidCctpAccount(uint32 domain, bytes32 account);
    error MessengerNotEvmShaped(uint32 domain, bytes32 messenger);
    error MessengerNotRaw32Shaped(uint32 domain, bytes32 messenger);
    error ZeroOwner();
    error ForwarderNotAllowed(address forwarder);
    error SubGranularityAmount(uint256 amount, uint256 granularity);

    // ─── CCTP (USDC) egress ──────────────────────────────────────────────────
    function burnUSDC(uint256 amount, address ethereumRecipient) external;
    function burnUSDC(uint256 amount, address recipient, uint32 destinationDomain) external;
    /// @notice For domains enabled with the RAW32 recipient kind only (Sui,
    ///         Aptos and the like). Reverts RecipientKindMismatch for an EVM domain.
    function burnUSDCToBytes32(uint256 amount, bytes32 recipient, uint32 destinationDomain) external;

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
    function setMessageRents(uint64 cctpLamports, uint64 wormholeLamports) external;
    /// @notice Owner only. Enables a CCTP domain after the contract reads and
    ///         checks Circle's own RemoteTokenMessenger record for it.
    /// @param  recipientKind 1 = EVM address, 2 = raw 32 bytes.
    function enableCctpDomain(uint32 domain, uint8 recipientKind) external;
    /// @notice Owner or guardian. Takes effect at once.
    function disableCctpDomain(uint32 domain) external;
    /// @notice Owner or guardian. Stops one rail.
    function pauseRail(Rail rail) external;
    /// @notice Owner only. Restarts a paused rail.
    function unpauseRail(Rail rail) external;
    /// @notice Owner only. address(0) removes the guardian.
    function setGuardian(address newGuardian) external;
    /// @notice Owner only. Step 1 of 2; address(0) cancels a pending transfer.
    function transferOwnership(address newOwner) external;
    /// @notice Step 2 of 2, called by the pending owner.
    function acceptOwnership() external;

    // ─── Views — preconditions and flow state ────────────────────────────────
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function guardian() external view returns (address);
    function VERSION() external view returns (string memory);
    /// @notice Every enabled CCTP domain, in no particular order.
    function cctpDomains() external view returns (uint32[] memory);
    /// @notice Circle RemoteTokenMessenger PDA of an enabled domain; zero when not enabled.
    function cctpRemoteTokenMessengers(uint32 domain) external view returns (bytes32);
    /// @notice 0 = not enabled, 1 = EVM address, 2 = raw 32 bytes.
    function cctpRecipientKind(uint32 domain) external view returns (uint8);
    function railPaused(Rail rail) external view returns (bool);
    function cctpMessageRentLamports() external view returns (uint64);
    function wormholeMessageRentLamports() external view returns (uint64);
    /// @notice Allow-list check keyed by WRAPPER address (resolves the mint internally).
    function wormholeAssetAllowed(address assetWrapper) external view returns (bool);
    /// @notice Allow-list check keyed by SPL MINT — the storage the egress paths gate on.
    function wormholeMintAllowed(bytes32 mint) external view returns (bool);
    function wormholeTargetChainAllowed(uint16 targetChain) external view returns (bool);
    /// @notice Per-user egress counter; lets a caller correlate emitted events.
    function burnNonce(address user) external view returns (uint64);
}
