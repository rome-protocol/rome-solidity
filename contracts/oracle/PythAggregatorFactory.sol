// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./PythAggregatorV3.sol";
import "../interface.sol";

/// @title PythAggregatorFactory
/// @notice Deploys per-feed PythAggregatorV3 adapters and maintains an
///         on-chain registry. Validates that the target account is owned
///         by the Pyth program at deploy time.
/// @dev Permissionless — anyone can create a feed, but the account must
///      be owned by the configured Pyth program ID.
contract PythAggregatorFactory {
    bytes32 public immutable pythProgramId;

    // On-chain registry
    mapping(bytes32 => address) public feedAdapters; // pythPubkey => adapter
    address[] public allAdapters;

    event FeedCreated(
        address indexed adapter,
        bytes32 indexed pythAccount,
        string description
    );

    /// @param _pythProgramId Pyth program ID for the target environment
    ///        (devnet/testnet/mainnet). Immutable after deploy.
    constructor(bytes32 _pythProgramId) {
        pythProgramId = _pythProgramId;
    }

    /// @notice Deploy a new PythAggregatorV3 adapter for a Pyth price feed
    /// @param pythAccountPubkey The Solana pubkey of the Pyth PriceAccount
    /// @param desc Human-readable description (e.g. "BTC/USD")
    /// @return The address of the deployed adapter contract
    function createFeed(
        bytes32 pythAccountPubkey,
        string calldata desc
    ) external returns (address) {
        require(feedAdapters[pythAccountPubkey] == address(0), "Feed exists");

        // Validate: account must be owned by Pyth program
        (uint64 lamports, bytes32 owner,,,,) =
            CpiProgram.account_info(pythAccountPubkey);
        require(owner == pythProgramId, "Not a Pyth account");
        require(lamports > 0, "Account does not exist");

        // Deploy full adapter contract (no proxy — zero overhead per read)
        PythAggregatorV3 adapter = new PythAggregatorV3(
            pythAccountPubkey,
            desc
        );

        feedAdapters[pythAccountPubkey] = address(adapter);
        allAdapters.push(address(adapter));

        emit FeedCreated(address(adapter), pythAccountPubkey, desc);
        return address(adapter);
    }

    /// @notice Total number of deployed feed adapters
    function totalFeeds() external view returns (uint256) {
        return allAdapters.length;
    }
}
