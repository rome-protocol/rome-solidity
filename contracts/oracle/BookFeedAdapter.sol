// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IAggregatorV3Interface.sol";
import "./IAdapterFactory.sol";
import "./IAdapterMetadata.sol";

/// @notice Read surface a BookFeedAdapter needs from the PriceBook.
interface IPriceBookRead {
    function entryOf(bytes32 sourceAccount)
        external
        view
        returns (int256 answer, uint64 publishTime, uint64 cachedAt, uint8 status);
}

/// @title BookFeedAdapter
/// @notice Chainlink-compatible view facade over one PriceBook entry. Holds no
///         cache of its own — `latestRoundData()` reads the book's entry for
///         its source account and applies the same staleness math as
///         CachedPythAdapter (clock = publishTime; same error selectors).
///
///         There is deliberately NO pause check on the read path — matching
///         CachedPythAdapter, where `_checkPaused` gates only `refresh()`.
///         Pausing this adapter in the book stops the book from refreshing the
///         entry, which then ages out and reads revert `StalePriceFeed`.
///
///         Deployed as EIP-1167 clone by the book at feed registration.
contract BookFeedAdapter is IAggregatorV3Interface, IAdapterMetadata {
    address public book;
    bytes32 public sourceAccount;
    string private _description;
    uint256 public maxStaleness;
    bool public initialized;
    uint64 public createdAt;

    error StalePriceFeed();
    error UninitializedPriceFeed();
    error HistoricalRoundsNotSupported();
    error AlreadyInitialized();
    error StalenessOutOfRange(uint256 staleness);

    /// @notice Lock the implementation from direct initialization (clones unaffected).
    constructor() {
        initialized = true;
    }

    function initialize(address _book, bytes32 _sourceAccount, string calldata desc, uint256 _maxStaleness)
        external
    {
        if (initialized) revert AlreadyInitialized();
        if (_maxStaleness < 1 || _maxStaleness > 24 hours) revert StalenessOutOfRange(_maxStaleness);
        initialized = true;
        book = _book;
        sourceAccount = _sourceAccount;
        _description = desc;
        maxStaleness = _maxStaleness;
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

    function metadata() external view override returns (AdapterMetadata memory) {
        return AdapterMetadata({
            description: _description,
            sourceType: OracleSource.Pyth,
            solanaAccount: sourceAccount,
            maxStaleness: maxStaleness,
            createdAt: createdAt,
            factory: book,
            paused: IAdapterFactory(book).isPaused(address(this))
        });
    }

    /// @notice Book entry as a Chainlink round. Pure SLOADs (via the book).
    ///         Reverts `UninitializedPriceFeed` before the entry's first commit
    ///         and `StalePriceFeed` past `maxStaleness` — same conditions and
    ///         selectors as CachedPythAdapter.
    function latestRoundData()
        external
        view
        override
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        (int256 a, uint64 publishTime,, uint8 status) = IPriceBookRead(book).entryOf(sourceAccount);
        if (status == 0) revert UninitializedPriceFeed();
        if (publishTime > block.timestamp || block.timestamp - publishTime > maxStaleness) {
            revert StalePriceFeed();
        }
        answer = a;
        roundId = 1;
        startedAt = uint256(publishTime);
        updatedAt = uint256(publishTime);
        answeredInRound = 1;
    }

    function getRoundData(uint80) external pure override returns (uint80, int256, uint256, uint256, uint80) {
        revert HistoricalRoundsNotSupported();
    }
}
