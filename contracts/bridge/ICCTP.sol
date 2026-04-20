// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ICrossProgramInvocation} from "../interface.sol";

/// @title CCTPLib
/// @notice Encodes deposit_for_burn instructions and account lists for the Circle CCTP
///         Token Messenger program, to be invoked via Rome's CPI precompile.
///         Matches the on-chain Anchor IDL (17-account layout) — earlier 13-account
///         layout was missing event_rent_payer, sender_authority_pda, and
///         message_transmitter_program and failed with AnchorError 3010 (AccountNotSigner).
library CCTPLib {
    uint32 internal constant DOMAIN_ETHEREUM = 0;
    uint32 internal constant DOMAIN_SOLANA   = 5;

    /// @dev Anchor discriminator for deposit_for_burn.
    ///      sha256("global:deposit_for_burn")[0..8] = d73c3d2e723780b0
    bytes8 internal constant DISCRIMINATOR_DEPOSIT_FOR_BURN = 0xd73c3d2e723780b0;

    /// @notice Parameters for the deposit_for_burn instruction.
    struct DepositForBurnParams {
        uint64 amount;
        uint32 destinationDomain;
        bytes32 mintRecipient;
    }

    /// @notice All 17 accounts required by the Anchor IDL for deposit_for_burn,
    ///         grouped into a struct to avoid stack-too-deep at the call site.
    struct DepositForBurnAccounts {
        bytes32 owner;                      // 1  signer, writable — user's Rome PDA
        bytes32 eventRentPayer;             // 2  signer, writable — pays rent for event data account
        bytes32 senderAuthorityPda;         // 3  readonly — PDA ["sender_authority"] under Token Messenger
        bytes32 burnTokenAccount;           // 4  writable — user's SPL ATA of the burn mint
        bytes32 messageTransmitter;         // 5  writable — MessageTransmitter config PDA
        bytes32 tokenMessenger;             // 6  readonly — TokenMessenger config PDA
        bytes32 remoteTokenMessenger;       // 7  readonly — destination-domain remote token messenger PDA
        bytes32 tokenMinter;                // 8  readonly — Token Minter PDA
        bytes32 localToken;                 // 9  writable — Local token PDA for the mint
        bytes32 burnTokenMint;              // 10 writable — SPL mint being burned
        bytes32 messageSentEventData;       // 11 signer, writable — event data account
        bytes32 messageTransmitterProgram;  // 12 readonly — MessageTransmitter program ID
        bytes32 tokenMessengerMinterProgram;// 13 readonly — Token Messenger Minter program ID
        bytes32 tokenProgram;               // 14 readonly — SPL Token program
        bytes32 systemProgram;              // 15 readonly — System program
        bytes32 eventAuthority;             // 16 readonly — Anchor event authority PDA
        bytes32 program;                    // 17 readonly — Token Messenger Minter program ID (again, as "program")
    }

    /// @notice Encodes a deposit_for_burn instruction payload.
    /// @dev Layout: [discriminator:8 BE raw][amount:8 LE][destination_domain:4 LE][mint_recipient:32]
    function encodeDepositForBurn(DepositForBurnParams memory p)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            DISCRIMINATOR_DEPOSIT_FOR_BURN,
            _u64le(p.amount),
            _u32le(p.destinationDomain),
            p.mintRecipient
        );
    }

    /// @notice Builds the ordered account list for deposit_for_burn per Circle's IDL.
    function buildDepositForBurnAccounts(DepositForBurnAccounts memory a)
        internal
        pure
        returns (ICrossProgramInvocation.AccountMeta[] memory metas)
    {
        metas = new ICrossProgramInvocation.AccountMeta[](17);

        metas[0]  = ICrossProgramInvocation.AccountMeta(a.owner,                       true,  true);
        metas[1]  = ICrossProgramInvocation.AccountMeta(a.eventRentPayer,              true,  true);
        metas[2]  = ICrossProgramInvocation.AccountMeta(a.senderAuthorityPda,          false, false);
        metas[3]  = ICrossProgramInvocation.AccountMeta(a.burnTokenAccount,            false, true);
        metas[4]  = ICrossProgramInvocation.AccountMeta(a.messageTransmitter,          false, true);
        metas[5]  = ICrossProgramInvocation.AccountMeta(a.tokenMessenger,              false, false);
        metas[6]  = ICrossProgramInvocation.AccountMeta(a.remoteTokenMessenger,        false, false);
        metas[7]  = ICrossProgramInvocation.AccountMeta(a.tokenMinter,                 false, false);
        metas[8]  = ICrossProgramInvocation.AccountMeta(a.localToken,                  false, true);
        metas[9]  = ICrossProgramInvocation.AccountMeta(a.burnTokenMint,               false, true);
        metas[10] = ICrossProgramInvocation.AccountMeta(a.messageSentEventData,        true,  true);
        metas[11] = ICrossProgramInvocation.AccountMeta(a.messageTransmitterProgram,   false, false);
        metas[12] = ICrossProgramInvocation.AccountMeta(a.tokenMessengerMinterProgram, false, false);
        metas[13] = ICrossProgramInvocation.AccountMeta(a.tokenProgram,                false, false);
        metas[14] = ICrossProgramInvocation.AccountMeta(a.systemProgram,               false, false);
        metas[15] = ICrossProgramInvocation.AccountMeta(a.eventAuthority,              false, false);
        metas[16] = ICrossProgramInvocation.AccountMeta(a.program,                     false, false);
    }

    // -------------------------------------------------------------------------
    // Internal serialization helpers
    // -------------------------------------------------------------------------

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
        b[0] = bytes1(uint8(v));
        b[1] = bytes1(uint8(v >> 8));
        b[2] = bytes1(uint8(v >> 16));
        b[3] = bytes1(uint8(v >> 24));
        b[4] = bytes1(uint8(v >> 32));
        b[5] = bytes1(uint8(v >> 40));
        b[6] = bytes1(uint8(v >> 48));
        b[7] = bytes1(uint8(v >> 56));
        return b;
    }
}
