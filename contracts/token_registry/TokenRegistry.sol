// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ITokenRegistry.sol";
import "../erc20spl/erc20spl_factory.sol";
import "../interface.sol";

/// @title TokenRegistry
/// @notice Admin-controlled registry for SPL-backed ERC-20 tokens. Deploys wrappers
///         via ERC20SPLFactory and stores cross-chain metadata for bridge resolution.
///         Follows the same owner pattern as OracleAdapterFactory.
contract TokenRegistry is ITokenRegistry {
    // --- State ---
    address public owner;
    ERC20SPLFactory public immutable factory;

    mapping(bytes32 => TokenEntry) private entries;         // splMint → entry
    mapping(bytes32 => bytes32) private externalToSpl;      // keccak(chainId, addr) → splMint
    bytes32[] private allMints;                              // enumerable list

    // --- Errors ---
    error OnlyOwner();
    error TokenAlreadyRegistered();
    error TokenNotRegistered();
    error InvalidMint();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(address _factory) {
        owner = msg.sender;
        factory = ERC20SPLFactory(_factory);
    }

    /// @notice Register an SPL token, deploying its ERC-20 wrapper via the factory
    function registerToken(
        bytes32 splMint,
        TokenOrigin origin,
        bytes32 externalAddress,
        uint16 externalChainId
    ) external onlyOwner returns (address wrapper) {
        // Check not already registered
        if (entries[splMint].erc20Wrapper != address(0)) revert TokenAlreadyRegistered();

        // Validate mint exists on-chain via CPI account_info
        (uint64 lamports, bytes32 accountOwner,,,,) = CpiProgram.account_info(splMint);
        if (lamports == 0 && accountOwner == bytes32(0)) revert InvalidMint();

        // Deploy wrapper via factory
        wrapper = factory.add_spl_token(splMint);

        // Store entry
        entries[splMint] = TokenEntry({
            splMint: splMint,
            erc20Wrapper: wrapper,
            origin: origin,
            externalAddress: externalAddress,
            externalChainId: externalChainId,
            active: true
        });

        allMints.push(splMint);

        // Index by external address for cross-chain lookup
        if (origin == TokenOrigin.WormholeWrapped && externalAddress != bytes32(0)) {
            bytes32 key = keccak256(abi.encodePacked(externalChainId, externalAddress));
            externalToSpl[key] = splMint;
        }

        emit TokenRegistered(splMint, wrapper, origin, externalChainId);
    }

    /// @notice Deactivate a registered token (wrapper still works, just flagged inactive)
    function deactivateToken(bytes32 splMint) external onlyOwner {
        if (entries[splMint].erc20Wrapper == address(0)) revert TokenNotRegistered();
        entries[splMint].active = false;
        emit TokenDeactivated(splMint);
    }

    /// @notice Transfer ownership
    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // --- Read functions ---

    function getToken(bytes32 splMint) external view returns (TokenEntry memory) {
        return entries[splMint];
    }

    function getTokenByExternal(uint16 chainId, bytes32 addr) external view returns (TokenEntry memory) {
        bytes32 key = keccak256(abi.encodePacked(chainId, addr));
        bytes32 splMint = externalToSpl[key];
        return entries[splMint]; // returns zero-initialized if not found
    }

    function getWrapper(bytes32 splMint) external view returns (address) {
        return entries[splMint].erc20Wrapper;
    }

    function isApproved(bytes32 splMint) external view returns (bool) {
        TokenEntry memory entry = entries[splMint];
        return entry.erc20Wrapper != address(0) && entry.active;
    }

    function tokenCount() external view returns (uint256) {
        return allMints.length;
    }

    function tokenAtIndex(uint256 index) external view returns (TokenEntry memory) {
        return entries[allMints[index]];
    }
}
