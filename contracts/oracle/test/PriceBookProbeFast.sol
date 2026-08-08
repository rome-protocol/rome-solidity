// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../PythPullParser.sol";
import {cpi_program_address, CpiProgram} from "../../interface.sol";

/// @title PriceBookProbeFast
/// @notice Optimized-parse variant of the PriceBook Phase-0 measurement
///         kernel. Same write-path semantics as PriceBookProbe (per-feed
///         fault isolation, monotonic skip, all-skip healthy, all-faulted
///         revert, feed_id binding), but built for the CU budget:
///
///         - branch-based fault isolation: no external self-call, no
///           try/catch — the fetch is a raw success-flagged staticcall and
///           the parse validates with flags, so nothing on the per-feed path
///           can revert the batch
///         - assembly parse: one mload + byteswap per field instead of
///           Convert's eight bounds-checked byte reads per u64; the unused
///           EMA fields are never touched
///         - cheap-skip: once a feed is bound, force=false ticks pre-read
///           publish_time alone (u64 at offset 93) and skip before the full
///           133-byte fetch + parse. A never-advancing mis-bound account is
///           therefore skipped rather than instantly faulted — it can never
///           serve a wrong price (the full path faults it on any advance)
///           and a permanently silent source is the age alert's job
///         - single packed storage slot per feed steady-state
///           (price8 i64 | publishTime u64 | cachedAt u64 | status u8);
///           feedId slot written once at bind
///
///         Normalization packs into int64: a normalized answer beyond int64
///         faults the feed (the legacy probe stores int256 and only faults
///         via arithmetic revert) — divergence exists only for |expo| far
///         outside Pyth's real range and is the book's intended R3 behavior.
contract PriceBookProbeFast {
    struct Entry {
        bytes32 feedId; // bound on first commit
        uint256 packed; // price8 i64 | publishTime u64 << 64 | cachedAt u64 << 128 | status u8 << 192
    }

    mapping(bytes32 => Entry) internal _entries;

    uint256 public constant MAX_CONF_BPS = 200;

    event FeedRefreshed(bytes32 indexed acct, bytes32 feedId, int256 answer, uint64 publishTime);
    event FeedSkippedNotNewer(bytes32 indexed acct, uint64 storedPublishTime);
    event FeedRefreshFailed(bytes32 indexed acct, bytes4 reason);

    error AllFeedsFaulted();
    error FetchFailed();
    error NonPositivePrice();
    error ConfidenceExceedsThreshold();
    error FeedIdMismatch();
    error NormalizationOverflow();

    uint256 private constant OUTCOME_COMMIT = 0;
    uint256 private constant OUTCOME_SKIP = 1;
    uint256 private constant OUTCOME_FAULT = 2;

    function refreshAll(bytes32[] calldata accts, bool force)
        external
        returns (uint256 committed, uint256 skipped, uint256 faulted)
    {
        for (uint256 i = 0; i < accts.length; i++) {
            (uint256 outcome, bytes4 reason) = _refreshOne(accts[i], force);
            if (outcome == OUTCOME_COMMIT) {
                committed++;
            } else if (outcome == OUTCOME_SKIP) {
                skipped++;
            } else {
                faulted++;
                emit FeedRefreshFailed(accts[i], reason);
            }
        }
        if (accts.length > 0 && faulted == accts.length) revert AllFeedsFaulted();
    }

    function getEntry(bytes32 acct)
        external
        view
        returns (int256 answer, bytes32 feedId, uint64 publishTime, uint64 status)
    {
        Entry storage e = _entries[acct];
        uint256 packed = e.packed;
        answer = int256(int64(uint64(packed)));
        feedId = e.feedId;
        publishTime = uint64(packed >> 64);
        status = uint8(packed >> 192);
    }

    // ── measurement decomposition entrypoints (no stores, real txs) ─────

    /// @notice Account fetch only — attributes the precompile-read share.
    function fetchAll(bytes32[] calldata accts) external returns (uint256 okCount) {
        for (uint256 i = 0; i < accts.length; i++) {
            (bool ok,) = _fetchRaw(accts[i]);
            if (ok) okCount++;
        }
    }

    /// @notice Fetch + fast parse + validate, no store.
    function parseAllFast(bytes32[] calldata accts) external returns (uint256 okCount) {
        for (uint256 i = 0; i < accts.length; i++) {
            (bool ok, bytes memory data) = _fetchRaw(accts[i]);
            if (!ok) continue;
            (bool pok,,,,,,) = _parseFast(data);
            if (pok) okCount++;
        }
    }

    /// @notice Fetch + LEGACY parser, no store — the A/B for the parse share.
    ///         Measurement-only: a malformed account reverts the whole call.
    function parseAllLegacy(bytes32[] calldata accts) external returns (uint256 okCount) {
        for (uint256 i = 0; i < accts.length; i++) {
            (bool ok, bytes memory data) = _fetchRaw(accts[i]);
            if (!ok) continue;
            PythPullParser.PythPullPrice memory p = PythPullParser.parse(data);
            if (p.publishTime != 0) okCount++;
        }
    }

    // ── per-feed unit: branches only, nothing here may revert ───────────

    function _refreshOne(bytes32 acct, bool force) internal returns (uint256 outcome, bytes4 reason) {
        Entry storage e = _entries[acct];
        uint256 packed = e.packed;
        uint8 status = uint8(packed >> 192);
        uint64 storedPt = uint64(packed >> 64);

        // Cheap-skip: bound feeds on a force=false tick peek publish_time
        // (one u64 read) before paying the full fetch + parse.
        if (status != 0 && !force) {
            (bool peeked, uint64 livePt) = _peekPublishTime(acct);
            if (peeked && livePt <= storedPt) {
                emit FeedSkippedNotNewer(acct, storedPt);
                return (OUTCOME_SKIP, 0);
            }
        }

        (bool ok, bytes memory data) = _fetchRaw(acct);
        if (!ok) return (OUTCOME_FAULT, FetchFailed.selector);
        (bool pok, bytes4 perr, int64 price, uint64 conf, int32 expo, uint64 publishTime, bytes32 feedId) =
            _parseFast(data);
        if (!pok) return (OUTCOME_FAULT, perr);

        if (status != 0) {
            if (e.feedId != feedId) return (OUTCOME_FAULT, FeedIdMismatch.selector);
            if (!force && publishTime <= storedPt) {
                emit FeedSkippedNotNewer(acct, storedPt);
                return (OUTCOME_SKIP, 0);
            }
        }
        if (price <= 0) return (OUTCOME_FAULT, NonPositivePrice.selector);
        if (uint256(conf) * 10_000 > uint256(uint64(price)) * MAX_CONF_BPS) {
            return (OUTCOME_FAULT, ConfidenceExceedsThreshold.selector);
        }
        (bool nok, int64 price8) = _normalize64(price, expo);
        if (!nok) return (OUTCOME_FAULT, NormalizationOverflow.selector);

        if (status == 0) e.feedId = feedId;
        e.packed = uint256(uint64(price8)) | (uint256(publishTime) << 64) | (uint256(uint64(block.timestamp)) << 128)
            | (uint256(1) << 192);
        emit FeedRefreshed(acct, feedId, int256(price8), publishTime);
        return (OUTCOME_COMMIT, 0);
    }

    /// @dev Assembly PriceUpdateV2 parse: discriminator + Full-variant guard,
    ///      then one mload + byteswap per needed field. Byte-equivalent to
    ///      PythPullParser.parse for the fields the book uses (EMA skipped).
    function _parseFast(bytes memory data)
        internal
        pure
        returns (bool ok, bytes4 err, int64 price, uint64 conf, int32 expo, uint64 publishTime, bytes32 feedId)
    {
        if (data.length < PythPullParser.MIN_DATA_LENGTH) {
            return (false, PythPullParser.PythPullDataTooShort.selector, 0, 0, 0, 0, 0);
        }
        bool discOk;
        bool variantOk;
        uint64 rawPrice;
        uint64 rawConf;
        uint32 rawExpo;
        uint64 rawPt;
        assembly {
            function le64(w) -> v {
                let x := shr(192, w)
                v :=
                    or(
                        or(
                            or(and(shr(56, x), 0xff), and(shr(40, x), 0xff00)),
                            or(and(shr(24, x), 0xff0000), and(shr(8, x), 0xff000000))
                        ),
                        or(
                            or(and(shl(8, x), 0xff00000000), and(shl(24, x), 0xff0000000000)),
                            or(and(shl(40, x), 0xff000000000000), shl(56, and(x, 0xff)))
                        )
                    )
            }
            let p := add(data, 0x20)
            discOk := eq(shr(192, mload(p)), 0x22f123639d7ef4cd)
            variantOk := eq(byte(0, mload(add(p, 40))), 0x01)
            feedId := mload(add(p, 41))
            rawPrice := le64(mload(add(p, 73)))
            rawConf := le64(mload(add(p, 81)))
            let y := shr(224, mload(add(p, 89)))
            rawExpo :=
                or(
                    or(and(shr(24, y), 0xff), and(shr(8, y), 0xff00)),
                    or(and(shl(8, y), 0xff0000), shl(24, and(y, 0xff)))
                )
            rawPt := le64(mload(add(p, 93)))
        }
        if (!discOk) return (false, PythPullParser.InvalidPythPullAccount.selector, 0, 0, 0, 0, 0);
        if (!variantOk) return (false, PythPullParser.UnsupportedVerificationVariant.selector, 0, 0, 0, 0, 0);
        return (true, 0, int64(rawPrice), rawConf, int32(rawExpo), rawPt, feedId);
    }

    /// @dev Normalize to 8 decimals and pack into int64, faulting instead of
    ///      reverting on overflow (R3). Mirrors the adapter math for all sane
    ///      exponents; guards keep every path revert-free.
    function _normalize64(int64 price, int32 expo) internal pure returns (bool ok, int64 price8) {
        int256 scaled = int256(price);
        int32 diff = expo + 8;
        if (diff > 0) {
            if (diff > 18) return (false, 0); // price*10^19 can never fit int64
            scaled = scaled * int256(10 ** uint32(diff));
        } else if (diff < 0) {
            if (diff < -76) return (false, 0); // legacy reverts (10**77 overflow) → fault
            if (diff < -18) return (true, 0); // any int64 / 10^19 == 0, match legacy
            scaled = scaled / int256(10 ** uint32(-diff));
        }
        if (scaled > type(int64).max || scaled < type(int64).min) return (false, 0);
        return (true, int64(scaled));
    }

    /// @dev Raw success-flagged account read: account_data_at via staticcall,
    ///      payload lifted without abi.decode. Failure returns ok=false —
    ///      never reverts. Virtual for the test harness.
    function _fetchRaw(bytes32 acct) internal view virtual returns (bool ok, bytes memory data) {
        address cpi = cpi_program_address;
        uint256 want = PythPullParser.MIN_DATA_LENGTH;
        assembly {
            let m := mload(0x40)
            mstore(m, shl(224, 0x593762e8)) // account_data_at(bytes32,uint16,uint16)
            mstore(add(m, 4), acct)
            mstore(add(m, 36), 0)
            mstore(add(m, 68), want)
            ok := staticcall(gas(), cpi, m, 100, 0, 0)
            if ok {
                switch lt(returndatasize(), 0x40)
                case 1 { ok := 0 }
                default {
                    returndatacopy(m, 0x20, 0x20)
                    let len := mload(m)
                    switch lt(len, want)
                    case 1 { ok := 0 }
                    default {
                        data := m
                        mstore(data, len)
                        let padded := and(add(len, 31), not(31))
                        returndatacopy(add(data, 0x20), 0x40, padded)
                        mstore(0x40, add(add(data, 0x20), padded))
                    }
                }
            }
        }
    }

    /// @dev Cheap-skip pre-read: publish_time as a single LE u64 at offset 93.
    ///      Virtual for the test harness.
    function _peekPublishTime(bytes32 acct) internal view virtual returns (bool ok, uint64 publishTime) {
        try CpiProgram.account_u64_at(acct, 93) returns (uint64 pt) {
            return (true, pt);
        } catch {
            return (false, 0);
        }
    }
}
