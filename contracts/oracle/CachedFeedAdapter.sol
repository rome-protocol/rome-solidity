// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IAggregatorV3Interface.sol";
import "./IAdapterFactory.sol";

/// @title CachedFeedAdapter
/// @notice A source-agnostic caching decorator over ANY AggregatorV3 price feed
///         (a PythPullAdapter, a SwitchboardV3Adapter, a Chainlink feed, …).
///
///         `refresh()` is a STATE-CHANGING, keeper-driven call: it reads the
///         wrapped `underlying` feed once (paying whatever that feed's read
///         costs — e.g. the ~405K-CU Pyth Borsh parse) and SSTOREs the result.
///
///         `latestRoundData()` is a `view` that is a pure SLOAD of the cached
///         value. So a consumer reading the feed inside a metered atomic tx
///         (e.g. a Compound borrow's collateralization check) pays a cheap
///         SLOAD instead of the underlying's full read on every call.
///
///         Unlike `CachedPythAdapter` (which re-implements the Pyth parse and
///         is Pyth-only), this contract composes with any source by delegating
///         the read to the underlying adapter. It caches the price only — not
///         source-specific extras (Pyth confidence/EMA); consumers needing
///         those read the underlying directly.
///
///         AggregatorV3 drop-in. Deployed as an EIP-1167 clone (the
///         implementation is constructor-locked).
contract CachedFeedAdapter is IAggregatorV3Interface {
    address public underlying;
    string private _description;
    uint256 public maxStaleness;
    address public factory; // optional; address(0) disables the pause check
    bool public initialized;
    uint8 private _decimals; // snapshotted from the underlying at init
    uint64 public createdAt;

    // ── cache: written by refresh(), read (SLOAD) by latestRoundData() ──
    int256 public cachedAnswer;
    uint256 public cachedUpdatedAt; // the underlying round's updatedAt
    uint64 public cachedAt; // block.timestamp of last refresh (0 = never refreshed)

    error StalePriceFeed();
    error UninitializedPriceFeed();
    error AdapterPaused();
    error HistoricalRoundsNotSupported();
    error NonPositivePrice();
    error AlreadyInitialized();
    error StalenessOutOfRange(uint256 staleness);
    error ZeroUnderlying();

    event PriceRefreshed(int256 answer, uint256 updatedAt, uint64 at);

    /// @notice Lock the implementation from direct initialization (clones unaffected).
    constructor() {
        initialized = true;
    }

    function initialize(
        address _underlying,
        string calldata desc,
        uint256 _maxStaleness,
        address _factory
    ) external {
        if (initialized) revert AlreadyInitialized();
        if (_underlying == address(0)) revert ZeroUnderlying();
        if (_maxStaleness < 1 || _maxStaleness > 24 hours) revert StalenessOutOfRange(_maxStaleness);
        initialized = true;
        underlying = _underlying;
        _description = desc;
        maxStaleness = _maxStaleness;
        factory = _factory;
        _decimals = IAggregatorV3Interface(_underlying).decimals();
        createdAt = uint64(block.timestamp);
    }

    function decimals() external view override returns (uint8) {
        return _decimals;
    }

    function description() external view override returns (string memory) {
        return _description;
    }

    function version() external pure override returns (uint256) {
        return 2;
    }

    /// @notice Keeper-driven snapshot: read the underlying feed and store the
    ///         result. Pays the underlying's read cost here (its own tx), NOT
    ///         on the consumer's read path. Reverts rather than caching a bad or
    ///         stale price so a cache hit is always a usable price.
    function refresh() external {
        _checkPaused();
        (, int256 answer,, uint256 updatedAt,) = IAggregatorV3Interface(underlying).latestRoundData();
        if (answer <= 0) revert NonPositivePrice();
        _checkStaleness(updatedAt);
        cachedAnswer = answer;
        cachedUpdatedAt = updatedAt;
        cachedAt = uint64(block.timestamp);
        emit PriceRefreshed(answer, updatedAt, cachedAt);
    }

    /// @notice Cached price as a Chainlink round. Pure SLOAD. Reverts if never
    ///         refreshed (`UninitializedPriceFeed`) or the cached price is older
    ///         than `maxStaleness` (`StalePriceFeed`) — so a stalled keeper
    ///         fails loud instead of serving a frozen price.
    function latestRoundData()
        external
        view
        override
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        if (cachedAt == 0) revert UninitializedPriceFeed();
        _checkStaleness(cachedUpdatedAt);
        answer = cachedAnswer;
        roundId = 1;
        startedAt = cachedUpdatedAt;
        updatedAt = cachedUpdatedAt;
        answeredInRound = 1;
    }

    function getRoundData(uint80) external pure override returns (uint80, int256, uint256, uint256, uint80) {
        revert HistoricalRoundsNotSupported();
    }

    // ── internals ──

    function _checkStaleness(uint256 updatedAt) internal view {
        if (updatedAt > block.timestamp || block.timestamp - updatedAt > maxStaleness) {
            revert StalePriceFeed();
        }
    }

    function _checkPaused() internal view {
        if (factory != address(0) && IAdapterFactory(factory).isPaused(address(this))) revert AdapterPaused();
    }
}
