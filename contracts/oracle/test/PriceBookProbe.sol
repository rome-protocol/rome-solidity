// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../PythPullParser.sol";
import {AccountReader} from "../../cpi/AccountReader.sol";

/// @title PriceBookProbe
/// @notice Phase-0 measurement kernel for the PriceBook spec: N feeds of
///         (account read + PriceUpdateV2 parse + validate + SSTORE) inside ONE
///         transaction, per-feed fault-isolated. This exists to measure compute
///         units, account metas, and serialized tx size at widths 1/2/4/8 on a
///         live chain — it is NOT the production book (no factory, no
///         registration flow, no read adapters, no pause hook).
///
///         Write-path semantics mirror the spec so measured cost is honest:
///         - per-feed try-units: one malformed/faulted feed never reverts the
///           batch; it emits `FeedRefreshFailed` and the rest commit
///         - monotonic publishTime: an older/equal source is a per-feed skip
///           (`FeedSkippedNotNewer`), never a rollback, never a revert
///         - all-skip is a HEALTHY no-op; the batch reverts only when every
///           attempted feed faulted
///         - confidence / positive-price bounds fault the feed for the round
///         - feed_id integrity: the id parsed from the account bytes is bound
///           on first commit; any later mismatch faults the feed (steady-state
///           cost: one SLOAD + compare per feed, same as the book's
///           registration check)
///
///         Deliberately excluded (CU-negligible, one timestamp compare):
///         staleness windows — they would couple capacity runs to keeper
///         cadence without changing the measurement.
contract PriceBookProbe {
    struct Entry {
        int256 answer; // Chainlink-normalized 8 decimals
        bytes32 feedId; // bound on first commit, checked afterwards
        uint64 publishTime;
        uint64 cachedAt;
        uint8 status; // 0 = never written, 1 = active
    }

    mapping(bytes32 => Entry) public entries;

    /// @notice Max permitted conf/price ratio in bps (matches the adapters).
    uint256 public constant MAX_CONF_BPS = 200;

    event FeedRefreshed(bytes32 indexed acct, bytes32 feedId, int256 answer, uint64 publishTime);
    event FeedSkippedNotNewer(bytes32 indexed acct, uint64 storedPublishTime);
    event FeedRefreshFailed(bytes32 indexed acct, bytes4 reason);

    error NonPositivePrice();
    error ConfidenceExceedsThreshold();
    error FeedIdMismatch();
    error AllFeedsFaulted();
    error SelfOnly();

    /// @notice One tx, N feeds. `force` bypasses the monotonic skip so capacity
    ///         runs measure the full commit path at every width even when the
    ///         source did not advance between runs (steady-state rewrites; run
    ///         once beforehand so first-write storage creation is not counted).
    function refreshAll(bytes32[] calldata accts, bool force)
        external
        returns (uint256 committed, uint256 skipped, uint256 faulted)
    {
        for (uint256 i = 0; i < accts.length; i++) {
            try this.refreshOne(accts[i], force) returns (bool updated) {
                if (updated) {
                    committed++;
                } else {
                    skipped++;
                }
            } catch (bytes memory err) {
                faulted++;
                bytes4 sel;
                if (err.length >= 4) {
                    assembly {
                        sel := mload(add(err, 0x20))
                    }
                }
                emit FeedRefreshFailed(accts[i], sel);
            }
        }
        if (accts.length > 0 && faulted == accts.length) revert AllFeedsFaulted();
    }

    /// @notice Per-feed try-unit. External so refreshAll can catch its reverts;
    ///         callable only by the probe itself.
    function refreshOne(bytes32 acct, bool force) external returns (bool updated) {
        if (msg.sender != address(this)) revert SelfOnly();

        bytes memory data = _fetchAccount(acct);
        PythPullParser.PythPullPrice memory p = PythPullParser.parse(data);

        // feed_id at offset 41 of the raw account bytes (+0x20 length prefix).
        bytes32 parsedFeedId;
        assembly {
            parsedFeedId := mload(add(data, 0x49))
        }

        Entry storage e = entries[acct];
        if (e.status != 0 && e.feedId != parsedFeedId) revert FeedIdMismatch();
        if (e.status != 0 && !force && p.publishTime <= e.publishTime) {
            emit FeedSkippedNotNewer(acct, e.publishTime);
            return false;
        }
        if (p.price <= 0) revert NonPositivePrice();
        if (uint256(p.conf) * 10_000 > uint256(uint64(p.price)) * MAX_CONF_BPS) {
            revert ConfidenceExceedsThreshold();
        }

        if (e.status == 0) e.feedId = parsedFeedId;
        e.answer = _normalize(p.price, p.expo);
        e.publishTime = p.publishTime;
        e.cachedAt = uint64(block.timestamp);
        e.status = 1;
        emit FeedRefreshed(acct, parsedFeedId, e.answer, p.publishTime);
        return true;
    }

    /// @dev Virtual so the test harness can inject mock bytes (the account-read
    ///      precompile is unavailable on the simulated network).
    function _fetchAccount(bytes32 acct) internal view virtual returns (bytes memory) {
        return AccountReader.readBytesAt(acct, 0, uint16(PythPullParser.MIN_DATA_LENGTH));
    }

    /// @dev Normalize Pyth price to 8 decimals (same math as the adapters).
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
