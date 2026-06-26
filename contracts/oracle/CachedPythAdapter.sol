// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IAggregatorV3Interface.sol";
import "./IAdapterFactory.sol";
import "./IAdapterMetadata.sol";
import "./PythPullParser.sol";
import "../interface.sol";
import {AccountReader} from "../cpi/AccountReader.sol";

/// @title CachedPythAdapter
/// @notice A Pyth-Pull price adapter with an EVM-side cache.
///
///         `refresh()` is a STATE-CHANGING, keeper-driven call: it reads +
///         parses the on-chain Solana PriceUpdateV2 account ONCE (the ~405K-CU
///         Borsh parse) and SSTOREs the normalized 8-decimal price.
///
///         `latestRoundData()` is a `view` that is a pure SLOAD of that cached
///         value. So a consumer that reads the feed inside a metered atomic tx
///         (e.g. a Compound borrow's collateralization check, which calls the
///         feed via staticcall) pays a cheap SLOAD instead of the parse on
///         every read — measured ~114K vs ~511K per feed on Hadrian.
///
///         Trust model: the cache snapshots the VERIFIED on-chain Pyth account
///         (it reads + parses the Solana PDA the keeper keeps fresh), NOT a
///         keeper-supplied number — so it keeps the same provenance as
///         PythPullAdapter, just amortizing the parse across reads.
///
///         AggregatorV3 drop-in. Deployed as EIP-1167 clone (storage from the
///         clone's init path; the implementation is constructor-locked).
contract CachedPythAdapter is IAggregatorV3Interface, IAdapterMetadata {
    bytes32 public pythAccount;
    string private _description;
    uint256 public maxStaleness;
    address public factory; // optional; address(0) disables the pause check
    bool public initialized;
    uint64 public createdAt;

    // ── cache: written by refresh(), read (SLOAD) by latestRoundData() ──
    int256 public cachedAnswer; // normalized to 8 decimals
    uint64 public cachedPublishTime; // Pyth publish_time of the cached price
    uint64 public cachedAt; // block.timestamp of last refresh (0 = never refreshed)

    /// @notice Max permitted conf/price ratio in bps (matches PythPullAdapter).
    uint256 public constant MAX_CONF_BPS = 200;

    error StalePriceFeed();
    error UninitializedPriceFeed();
    error AdapterPaused();
    error HistoricalRoundsNotSupported();
    error NonPositivePrice();
    error AlreadyInitialized();
    error StalenessOutOfRange(uint256 staleness);
    error ConfidenceExceedsThreshold();

    event PriceRefreshed(int256 answer, uint64 publishTime, uint64 at);

    /// @notice Lock the implementation from direct initialization (clones unaffected).
    constructor() {
        initialized = true;
    }

    function initialize(
        bytes32 _pythAccount,
        string calldata desc,
        uint256 _maxStaleness,
        address _factory
    ) external {
        if (initialized) revert AlreadyInitialized();
        if (_maxStaleness < 1 || _maxStaleness > 24 hours) revert StalenessOutOfRange(_maxStaleness);
        initialized = true;
        pythAccount = _pythAccount;
        _description = desc;
        maxStaleness = _maxStaleness;
        factory = _factory;
        createdAt = uint64(block.timestamp);
    }

    function decimals() external pure override returns (uint8) {
        return 8;
    }

    function description() external view override returns (string memory) {
        return _description;
    }

    function version() external pure override returns (uint256) {
        return 2;
    }

    /// @notice Single-struct description so the portal / BatchReader can read
    ///         this cached adapter the same way it reads the raw adapters.
    function metadata() external view override returns (AdapterMetadata memory) {
        return AdapterMetadata({
            description: _description,
            sourceType: OracleSource.Pyth,
            solanaAccount: pythAccount,
            maxStaleness: maxStaleness,
            createdAt: createdAt,
            factory: factory,
            paused: factory != address(0) && IAdapterFactory(factory).isPaused(address(this))
        });
    }

    /// @notice Keeper-driven snapshot: read + parse the Solana Pyth account and
    ///         store the normalized price. Pays the parse here (its own tx),
    ///         NOT on the consumer's read path. Reverts rather than caching a
    ///         bad/stale price so a cache hit is always a usable price.
    function refresh() external {
        _checkPaused();
        PythPullParser.PythPullPrice memory parsed = PythPullParser.parse(_fetchAccount());
        if (parsed.price <= 0) revert NonPositivePrice();
        _checkConfidence(parsed.price, parsed.conf);
        _checkStaleness(parsed.publishTime);
        cachedAnswer = _normalize(parsed.price, parsed.expo);
        cachedPublishTime = parsed.publishTime;
        cachedAt = uint64(block.timestamp);
        emit PriceRefreshed(cachedAnswer, cachedPublishTime, cachedAt);
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
        _checkStaleness(cachedPublishTime);
        answer = cachedAnswer;
        roundId = 1;
        startedAt = uint256(cachedPublishTime);
        updatedAt = uint256(cachedPublishTime);
        answeredInRound = 1;
    }

    function getRoundData(uint80) external pure override returns (uint80, int256, uint256, uint256, uint80) {
        revert HistoricalRoundsNotSupported();
    }

    // ── internals (mirror PythPullAdapter) ──

    /// @dev Virtual so a test harness can inject mock bytes (the CPI precompile
    ///      is unavailable on hardhat's simulated network).
    function _fetchAccount() internal view virtual returns (bytes memory data) {
        data = AccountReader.readBytesAt(pythAccount, 0, uint16(PythPullParser.MIN_DATA_LENGTH));
    }

    function _checkStaleness(uint64 publishTime) internal view {
        if (publishTime > block.timestamp || block.timestamp - publishTime > maxStaleness) {
            revert StalePriceFeed();
        }
    }

    function _checkPaused() internal view {
        if (factory != address(0) && IAdapterFactory(factory).isPaused(address(this))) revert AdapterPaused();
    }

    function _checkConfidence(int64 price, uint64 conf) internal pure {
        if (price <= 0) revert NonPositivePrice();
        if (uint256(conf) * 10_000 > uint256(uint64(price)) * MAX_CONF_BPS) {
            revert ConfidenceExceedsThreshold();
        }
    }

    /// @dev Normalize Pyth price to 8 decimals: answer = price * 10^(expo+8).
    function _normalize(int64 price, int32 expo) internal pure returns (int256) {
        int256 scaledPrice = int256(price);
        int32 diff = expo - (-8);
        if (diff > 0) {
            scaledPrice = scaledPrice * int256(10 ** uint32(diff));
        } else if (diff < 0) {
            scaledPrice = scaledPrice / int256(10 ** uint32(-diff));
        }
        return scaledPrice;
    }
}
