// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IRomeBridgeWithdraw
/// @notice Discovery interface for the Rome bridge egress contract.
/// @dev    Deployed per-chain; the address is canonical in `rome-protocol/registry`
///         and is NEVER hardcoded here. Composers import this type and construct it
///         with a registry-sourced address (type from code, address from data).
///         Implementation: `contracts/bridge/RomeBridgeWithdraw.sol`.
interface IRomeBridgeWithdraw {
    // ─── Events ──────────────────────────────────────────────────────────────
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

    // ─── Wormhole (ETH + generic asset) egress ───────────────────────────────
    function approveBurnETH(uint256 amount) external;
    function burnETH(uint256 amount, address ethereumRecipient) external;
    function approveWormholeBurn(address assetWrapper, uint256 amount) external;

    // ─── ATA provisioning ────────────────────────────────────────────────────
    function ensureRecipientAta(bytes32 solanaRecipient, bytes32 mint) external;

    // ─── Admin / config ──────────────────────────────────────────────────────
    function setWormholeAssetAllowed(address assetWrapper, bool allowed) external;
    function wormholeAssetAllowed(address assetWrapper) external view returns (bool);
    function setWormholeTargetChainAllowed(uint16 targetChain, bool allowed) external;
    function transferOwnership(address newOwner) external;
}
