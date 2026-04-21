// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IAdapterMetadata
/// @notice Shared metadata shape exposed by Pyth and Switchboard adapters
///         so consumers (portal, integrators) can describe a feed with a
///         single on-chain call.
interface IAdapterMetadata {
    enum OracleSource { Pyth, Switchboard }

    struct AdapterMetadata {
        string description;       // human-readable pair ("SOL / USD")
        OracleSource sourceType;  // 0=Pyth, 1=Switchboard
        bytes32 solanaAccount;    // Solana account pubkey this adapter reads
        uint256 maxStaleness;     // staleness threshold in seconds
        uint64 createdAt;         // unix timestamp at initialize()
        address factory;          // deploying factory for pause lookup
        bool paused;              // live read from factory at call time
    }

    /// @notice Return a single-struct description of this adapter.
    function metadata() external view returns (AdapterMetadata memory);
}
