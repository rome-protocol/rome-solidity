// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";

/// Reference consumer for Pyth Lazer prices on Rome.
///
/// Spec: rome-specs/main/active/technical/2026-05-19-pyth-lazer-integration.md §5.2
///
/// Demonstrates the two responsibilities the IHelperProgram.lazer_price
/// wrapper does NOT enforce (per spec §3.4 — explicit consumer
/// responsibility for per-policy flexibility):
///
///   1. **Per-feed monotonic replay protection.** A single envelope can
///      carry N feeds at independent cadences. Per-feed
///      `lastAcceptedPublishTimeUs[feed_id]` is MANDATORY — a single
///      envelope-level timestamp is INSUFFICIENT (feed F1 can have a
///      newer publish_time than feed F2 within the same envelope).
///
///   2. **Staleness enforcement.** The wrapper returns whatever Pyth
///      signed, including stale payloads. The consumer enforces its own
///      max staleness window appropriate to its use case (Compound
///      liquidation tolerates 30s; bridge value verification needs
///      seconds; UI display tolerates minutes).
///
/// Real consumers (Compound on Rome, Cardo's Drift/Mango adapters) inline
/// this pattern. Multi-source aggregation (median of Lazer + Stork +
/// Switchboard On-Demand) is consumer-side composition; the wrapper is
/// designed as a primitive, not a policy.
contract lazer_consumer {
    uint32  public constant ETH_FEED = 2;
    uint64  public constant MAX_STALENESS_US = 60_000_000; // 60s in microseconds

    /// Per-feed monotonicity tracking — REQUIRED to prevent replay.
    /// Maps Pyth's u32 feed_id to the last publish_time_us we accepted.
    mapping(uint32 => uint64) public lastAcceptedPublishTimeUs;

    /// Pull a fresh ETH price from a Lazer envelope + record it.
    ///
    /// NOT `view` because it mutates `lastAcceptedPublishTimeUs`. A pure-
    /// view alternative (no monotonicity check) is acceptable only for
    /// low-stakes UI display; high-stakes use cases (lending liquidations,
    /// bridge value verification) MUST track monotonicity in storage to
    /// reject replays of older signed payloads.
    function getEthPrice(
        bytes calldata envelope,
        uint8 ed25519_ix_idx,
        uint8 sig_idx
    ) external returns (int64 price, int32 expo) {
        // 1. Verify + parse via the wrapper.
        (IHelperProgram.LazerFeedPrice[] memory feeds, uint64 publish_time_us)
            = HelperProgram.lazer_price(envelope, ed25519_ix_idx, sig_idx);

        // 2. Staleness check. block.timestamp is seconds; publish_time is microseconds.
        //    Solidity 0.8+ checked arithmetic catches the (block.timestamp * 1_000_000)
        //    multiplication overflow automatically — but only on the uint64 result, not
        //    on the input cast. Explicit upper-bound guard so the cast itself never
        //    silently wraps if block.timestamp exceeds uint64 microsecond range
        //    (year 586,524+ — practically unreachable, but the check is cheap).
        require(
            block.timestamp < type(uint64).max / 1_000_000,
            "block timestamp out of uint64 microsecond range"
        );
        uint64 now_us = uint64(block.timestamp) * 1_000_000;
        require(now_us >= publish_time_us, "future-dated payload");
        require(now_us - publish_time_us <= MAX_STALENESS_US, "stale payload");

        // 3. Find ETH feed and enforce monotonicity.
        for (uint256 i = 0; i < feeds.length; i++) {
            if (feeds[i].feed_id == ETH_FEED) {
                require(
                    publish_time_us > lastAcceptedPublishTimeUs[ETH_FEED],
                    "replay: publish_time not strictly increasing"
                );
                lastAcceptedPublishTimeUs[ETH_FEED] = publish_time_us;
                return (feeds[i].price, feeds[i].expo);
            }
        }
        revert("ETH feed not in payload");
    }
}
