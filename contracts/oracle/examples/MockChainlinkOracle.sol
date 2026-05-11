// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../IAggregatorV3Interface.sol";

/// @title MockChainlinkOracle
/// @notice Operator-settable Chainlink-shaped price feed for testnet environments
///         where real oracles (Pyth Pull / Switchboard V3) aren't deployed on
///         the underlying Solana cluster.
///
///         Implements IAggregatorV3Interface exactly so any consumer written
///         for Chainlink on Ethereum — Compound v3 Comet, Aave, etc. — drops
///         in without code changes. The owner sets the answer manually via
///         setAnswer(); there is no automated update mechanism.
///
/// @dev    Production paths use PythPullAdapter or SwitchboardV3Adapter, which
///         read live Solana on-chain account data via CPI. MockChainlinkOracle
///         is for environments where those upstreams don't exist (Solana testnet
///         per 2026-05-11 probe: no Pyth, no Switchboard) AND we don't want to
///         redeploy mainnet program bytecode (operational burden).
///
///         8-decimal answer matches Chainlink convention. Default initial
///         _roundId is 1; setAnswer increments per call so consumers tracking
///         roundId observe monotonically-increasing updates.
contract MockChainlinkOracle is IAggregatorV3Interface {
    address public immutable owner;

    string public override description;
    uint8 public constant override decimals = 8;
    uint256 public constant override version = 1;

    int256 private _answer;
    uint80 private _roundId;
    uint256 private _updatedAt;

    event AnswerUpdated(int256 indexed current, uint80 indexed roundId, uint256 updatedAt);

    /// @param desc Human-readable description (e.g. "USDC / USD (mock)").
    /// @param initialAnswer Starting price in 8-decimal Chainlink convention
    ///        (e.g. 100_000_000 = $1.00).
    constructor(string memory desc, int256 initialAnswer) {
        owner = msg.sender;
        description = desc;
        _answer = initialAnswer;
        _roundId = 1;
        _updatedAt = block.timestamp;
        emit AnswerUpdated(initialAnswer, 1, block.timestamp);
    }

    /// @notice Set the latest answer. Restricted to owner; bumps _roundId.
    function setAnswer(int256 newAnswer) external {
        require(msg.sender == owner, "MockOracle: not owner");
        _roundId += 1;
        _answer = newAnswer;
        _updatedAt = block.timestamp;
        emit AnswerUpdated(newAnswer, _roundId, block.timestamp);
    }

    /// @notice Returns the latest round (this mock has no historical rounds).
    /// @dev    The _roundId argument is ignored — every call returns the
    ///         current state. Consumers that walk historical rounds will see
    ///         only the latest; tests should not depend on multi-round history.
    function getRoundData(uint80 /* _round */) external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }

    /// @notice Returns the latest round data in Chainlink-V3 shape.
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }
}
