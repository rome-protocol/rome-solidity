// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IAggregatorV3Interface.sol";
import "./IAdapterMetadata.sol";
import "./IAdapterFactory.sol";
import "./IPythLazerCache.sol";

/// @title PythLazerFeedAdapter
/// @notice Per-feed Chainlink-compatible view over PythLazerCache.
///         Deployed as an EIP-1167 minimal-proxy clone by
///         OracleAdapterFactory.createLazerFeed(feedId, description, maxConfBps).
///         Implementation is locked in the constructor; only clones are usable.
///
/// Reads from the singleton cache for its feed id; enforces freshness against
/// the cache's chain-wide `maxStaleness`; rejects on cold-start
/// (cache.timestamp == 0) with a distinct error vs the stale path; rejects
/// updates whose confidence interval exceeds `maxConfBps` of the price.
///
/// Spec: rome-specs/active/technical/2026-05-20-og-v2-pyth-lazer-adapter.md §3.3
contract PythLazerFeedAdapter is IAggregatorV3Interface, IAdapterMetadata {
    address public cache;        // PythLazerCache address; set in initialize
    uint32  public feedId;       // which Lazer feed this adapter serves
    string  private _description;
    address public factory;
    bool    public initialized;
    uint64  public createdAt;
    uint256 public maxConfBps;   // confidence-interval rejection cap

    /// Mirrors PythPullAdapter.MAX_CONF_BPS (= 2%).
    uint256 public constant MAX_CONF_BPS_DEFAULT = 200;
    /// Absolute upper bound — prevents misconfig opening up oracle to wide-conf
    /// poisoning. Matches PythPullAdapter's implicit cap (24h staleness is
    /// the same conservative philosophy).
    uint256 public constant MAX_CONF_BPS_CAP = 1000;

    error AlreadyInitialized();
    error MaxConfBpsOutOfRange(uint256 bps);
    error UninitializedPriceFeed();
    error StalePriceFeed();
    error AdapterPaused();
    error NonPositivePrice();
    error ConfidenceExceedsThreshold();
    error HistoricalRoundsNotSupported();

    /// @notice Lock the implementation contract — only clones initialized via
    ///         the factory are valid. Direct callers on the implementation
    ///         can never run initialize().
    constructor() {
        initialized = true;
    }

    /// @notice One-time init. Called by OracleAdapterFactory after Clones.clone.
    /// @param _cache       PythLazerCache singleton address.
    /// @param _feedId      Pyth Lazer feed id this adapter exposes.
    /// @param desc         Human-readable description (e.g. "BTC / USD").
    /// @param _maxConfBps  Confidence rejection threshold in basis points
    ///                     (0 → use MAX_CONF_BPS_DEFAULT). Cap = 1000.
    /// @param _factory     OracleAdapterFactory address (for pause + admin).
    function initialize(
        address _cache,
        uint32 _feedId,
        string calldata desc,
        uint256 _maxConfBps,
        address _factory
    ) external {
        if (initialized) revert AlreadyInitialized();
        if (_maxConfBps > MAX_CONF_BPS_CAP) revert MaxConfBpsOutOfRange(_maxConfBps);
        initialized = true;

        cache = _cache;
        feedId = _feedId;
        _description = desc;
        maxConfBps = _maxConfBps == 0 ? MAX_CONF_BPS_DEFAULT : _maxConfBps;
        factory = _factory;
        createdAt = uint64(block.timestamp);
    }

    // ─── IAggregatorV3Interface ───────────────────────────────────────────

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function description() external view returns (string memory) {
        return _description;
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        if (IAdapterFactory(factory).isPaused(address(this))) revert AdapterPaused();

        IPythLazerCache.CachedPrice memory p = IPythLazerCache(cache).getPrice(feedId);

        // Cold-start: cache has never been refreshed for this feedId.
        if (p.timestamp == 0) revert UninitializedPriceFeed();

        uint256 _maxStaleness = uint256(IPythLazerCache(cache).maxStaleness());
        if (block.timestamp - p.timestamp > _maxStaleness) revert StalePriceFeed();
        if (p.answer <= 0) revert NonPositivePrice();

        // Confidence-interval rejection — mirrors PythPullAdapter.MAX_CONF_BPS.
        // (conf * 10_000) / answer must not exceed maxConfBps.
        uint256 confBps = (uint256(p.confidence) * 10_000) / uint256(p.answer);
        if (confBps > maxConfBps) revert ConfidenceExceedsThreshold();

        return (p.roundId, p.answer, p.timestamp, p.timestamp, p.roundId);
    }

    function getRoundData(uint80) external pure
        returns (uint80, int256, uint256, uint256, uint80)
    {
        revert HistoricalRoundsNotSupported();
    }

    // ─── IAdapterMetadata ─────────────────────────────────────────────────
    //
    // The existing IAdapterMetadata.OracleSource enum has values Pyth (=0)
    // and Switchboard (=1). Lazer is a new source family; until the enum is
    // extended (see CHANGELOG when this PR lands), we return OracleSource.Pyth
    // for the sourceType field — Lazer is Pyth's product line, and consumers
    // currently parsing this enum will see "a Pyth feed" rather than an
    // unknown value. A follow-up PR adds OracleSource.PythLazer = 2 and
    // updates this return + all consumers in lockstep.

    function metadata() external view returns (AdapterMetadata memory) {
        return AdapterMetadata({
            description: _description,
            sourceType: OracleSource.Pyth,
            // bytes32(0) — Lazer has no per-feed Solana account (cache reads
            // the on-chain Lazer Storage PDA via helper.lazer_price). Set to
            // bytes32(0) until/unless the enum is extended to PythLazer.
            solanaAccount: bytes32(0),
            maxStaleness: uint256(IPythLazerCache(cache).maxStaleness()),
            createdAt: createdAt,
            factory: factory,
            paused: IAdapterFactory(factory).isPaused(address(this))
        });
    }
}
