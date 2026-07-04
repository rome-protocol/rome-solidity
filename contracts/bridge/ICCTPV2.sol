// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ICrossProgramInvocation} from "../interface.sol";

/// @title CCTPV2Lib
/// @notice Encodes deposit_for_burn instructions and account lists for the
///         Circle CCTP **v2** Token Messenger Minter program
///         (CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe on devnet+mainnet),
///         invoked via Rome's CPI precompile. Sibling of the v1 CCTPLib —
///         v2 is required for destinations that are v2-only (Monad = domain
///         15) and is the go-forward protocol for every destination.
///
///         Ground truth: account ordering + instruction bytes reproduce a
///         LANDED devnet v2 deposit_for_burn
///         (4L4D7Qo7DNFfdGXY4AhYYiFfbdhxwSZruteaxVTUaSkXBpVrNBoyTmU47mZSuo6YUwNUWQNqneks9QWcyzNbLoPY)
///         byte-for-byte — see tests/bridge/cctp_v2_lib.test.ts.
library CCTPV2Lib {
    uint32 internal constant DOMAIN_SOLANA = 5;

    /// @dev Standard-finality tier (free per Circle's fee schedule; the
    ///      fast tier 1000 costs bps). Matches the UI-side burn constants.
    uint32 internal constant MIN_FINALITY_STANDARD = 2000;

    /// @dev Anchor discriminator — same method name as v1, so the same
    ///      sha256("global:deposit_for_burn")[0..8].
    bytes8 internal constant DISCRIMINATOR_DEPOSIT_FOR_BURN = 0xd73c3d2e723780b0;

    /// @notice v2 deposit_for_burn args. v2 adds destination_caller
    ///         (bytes32(0) = permissionless relay), max_fee, and
    ///         min_finality_threshold over v1.
    struct DepositForBurnParams {
        uint64 amount;
        uint32 destinationDomain;
        bytes32 mintRecipient;
        bytes32 destinationCaller;
        uint64 maxFee;
        uint32 minFinalityThreshold;
    }

    /// @notice The 18 accounts of the landed v2 layout, plus the trailing
    ///         MessageTransmitter __event_authority inherited from the v1
    ///         Rome-emulator workaround (post-#266 Mollusk ix_store filter;
    ///         trailing accounts are ignored by Anchor on-chain).
    ///         v2 deltas vs v1: + denylist_account (per-owner PDA, index 4);
    ///         remote_token_messenger remains PER DESTINATION DOMAIN.
    struct DepositForBurnAccounts {
        bytes32 owner;                       // 0  signer, writable — user's Rome PDA
        bytes32 eventRentPayer;              // 1  signer, writable
        bytes32 senderAuthorityPda;          // 2  readonly — ["sender_authority"] under TMM v2
        bytes32 burnTokenAccount;            // 3  writable — user's USDC ATA
        bytes32 denylistAccount;             // 4  readonly — ["denylist_account", owner] under TMM v2
        bytes32 messageTransmitter;          // 5  writable — MT v2 config
        bytes32 tokenMessenger;              // 6  readonly — TMM v2 config
        bytes32 remoteTokenMessenger;        // 7  readonly — ["remote_token_messenger", dec(domain)]
        bytes32 tokenMinter;                 // 8  writable
        bytes32 localToken;                  // 9  writable
        bytes32 burnTokenMint;               // 10 writable
        bytes32 messageSentEventData;        // 11 signer, writable — per-tx salted PDA
        bytes32 messageTransmitterProgram;   // 12 readonly
        bytes32 tokenMessengerMinterProgram; // 13 readonly
        bytes32 tokenProgram;                // 14 readonly
        bytes32 systemProgram;               // 15 readonly
        bytes32 eventAuthority;              // 16 readonly — TMM __event_authority
        bytes32 program;                     // 17 readonly — TMM program (again)
        bytes32 messageTransmitterEventAuthority; // 18 readonly — trailing emulator workaround
    }

    /// @notice Encodes the v2 deposit_for_burn payload.
    /// @dev Layout (96 bytes): [disc:8][amount:8 LE][destination_domain:4 LE]
    ///      [mint_recipient:32][destination_caller:32][max_fee:8 LE]
    ///      [min_finality_threshold:4 LE]
    function encodeDepositForBurn(DepositForBurnParams memory p)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            DISCRIMINATOR_DEPOSIT_FOR_BURN,
            _u64le(p.amount),
            _u32le(p.destinationDomain),
            p.mintRecipient,
            p.destinationCaller,
            _u64le(p.maxFee),
            _u32le(p.minFinalityThreshold)
        );
    }

    /// @notice Ordered account list per the landed v2 layout (+ trailing meta).
    function buildDepositForBurnAccounts(DepositForBurnAccounts memory a)
        internal
        pure
        returns (ICrossProgramInvocation.AccountMeta[] memory metas)
    {
        metas = new ICrossProgramInvocation.AccountMeta[](19);
        metas[0]  = ICrossProgramInvocation.AccountMeta(a.owner,                       true,  true);
        metas[1]  = ICrossProgramInvocation.AccountMeta(a.eventRentPayer,              true,  true);
        metas[2]  = ICrossProgramInvocation.AccountMeta(a.senderAuthorityPda,          false, false);
        metas[3]  = ICrossProgramInvocation.AccountMeta(a.burnTokenAccount,            false, true);
        metas[4]  = ICrossProgramInvocation.AccountMeta(a.denylistAccount,             false, false);
        metas[5]  = ICrossProgramInvocation.AccountMeta(a.messageTransmitter,          false, true);
        metas[6]  = ICrossProgramInvocation.AccountMeta(a.tokenMessenger,              false, false);
        metas[7]  = ICrossProgramInvocation.AccountMeta(a.remoteTokenMessenger,        false, false);
        metas[8]  = ICrossProgramInvocation.AccountMeta(a.tokenMinter,                 false, true);
        metas[9]  = ICrossProgramInvocation.AccountMeta(a.localToken,                  false, true);
        metas[10] = ICrossProgramInvocation.AccountMeta(a.burnTokenMint,               false, true);
        metas[11] = ICrossProgramInvocation.AccountMeta(a.messageSentEventData,        true,  true);
        metas[12] = ICrossProgramInvocation.AccountMeta(a.messageTransmitterProgram,   false, false);
        metas[13] = ICrossProgramInvocation.AccountMeta(a.tokenMessengerMinterProgram, false, false);
        metas[14] = ICrossProgramInvocation.AccountMeta(a.tokenProgram,                false, false);
        metas[15] = ICrossProgramInvocation.AccountMeta(a.systemProgram,               false, false);
        metas[16] = ICrossProgramInvocation.AccountMeta(a.eventAuthority,              false, false);
        metas[17] = ICrossProgramInvocation.AccountMeta(a.program,                     false, false);
        // Trailing Rome-emulator workaround — see struct doc.
        metas[18] = ICrossProgramInvocation.AccountMeta(a.messageTransmitterEventAuthority, false, false);
    }

    function _u32le(uint32 v) private pure returns (bytes memory) {
        bytes memory b = new bytes(4);
        b[0] = bytes1(uint8(v));
        b[1] = bytes1(uint8(v >> 8));
        b[2] = bytes1(uint8(v >> 16));
        b[3] = bytes1(uint8(v >> 24));
        return b;
    }

    function _u64le(uint64 v) private pure returns (bytes memory) {
        bytes memory b = new bytes(8);
        for (uint256 i = 0; i < 8; i++) {
            b[i] = bytes1(uint8(v >> (8 * i)));
        }
        return b;
    }
}
