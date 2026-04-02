// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

enum TokenOrigin { NativeSPL, WormholeWrapped }

struct TokenEntry {
    bytes32 splMint;
    address erc20Wrapper;
    TokenOrigin origin;
    bytes32 externalAddress;    // Original token on source chain (0 for native)
    uint16 externalChainId;     // Wormhole chain ID (0 for native SPL)
    bool active;
}

interface ITokenRegistry {
    // --- Events ---
    event TokenRegistered(
        bytes32 indexed splMint,
        address indexed wrapper,
        TokenOrigin origin,
        uint16 externalChainId
    );
    event TokenDeactivated(bytes32 indexed splMint);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    // --- Write ---
    function registerToken(
        bytes32 splMint,
        TokenOrigin origin,
        bytes32 externalAddress,
        uint16 externalChainId
    ) external returns (address wrapper);

    function deactivateToken(bytes32 splMint) external;
    function transferOwnership(address newOwner) external;

    // --- Read ---
    function getToken(bytes32 splMint) external view returns (TokenEntry memory);
    function getTokenByExternal(uint16 chainId, bytes32 addr) external view returns (TokenEntry memory);
    function getWrapper(bytes32 splMint) external view returns (address);
    function isApproved(bytes32 splMint) external view returns (bool);
    function tokenCount() external view returns (uint256);
    function tokenAtIndex(uint256 index) external view returns (TokenEntry memory);
}
