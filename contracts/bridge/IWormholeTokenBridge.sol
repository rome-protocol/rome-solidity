// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ICrossProgramInvocation} from "../interface.sol";

/// @title WormholeTokenBridgeLib
/// @notice Encodes transfer_tokens instructions and account lists for the Wormhole Token Bridge
///         Solana program, to be invoked via Rome's CPI precompile.
library WormholeTokenBridgeLib {
    uint8 internal constant TRANSFER_TOKENS_TAG = 0x04;

    /// @notice TransferWrapped instruction tag in Wormhole Token Bridge solitaire enum.
    /// @dev Enum-index 4 in the solitaire! macro order:
    ///      Initialize=0, AttestToken=1, CompleteNative=2, CompleteWrapped=3,
    ///      TransferWrapped=4, TransferNative=5, ...
    ///      Coincides numerically with TRANSFER_TOKENS_TAG; kept separate for clarity.
    uint8 internal constant TRANSFER_WRAPPED_TAG = 0x04;

    /// @notice Parameters for the transfer_tokens instruction.
    /// @dev amount and fee are u64 — Wormhole Token Bridge native format.
    ///      Callers accepting uint256 from the ERC-20 boundary must range-check
    ///      before constructing this struct (truncation guard belongs at the call site).
    struct TransferParams {
        uint64 amount;
        uint64 fee;
        bytes32 targetAddress;
        uint16 targetChain;
        uint32 nonce;
    }

    /// @notice Aggregated account references for the transfer_tokens instruction.
    /// @dev Passed as a single struct to avoid stack-too-deep in buildAccounts.
    struct TransferAccounts {
        bytes32 payer;
        bytes32 config;
        bytes32 from_owner;
        bytes32 from;
        bytes32 mint;
        bytes32 custody;
        bytes32 authority_signer;
        bytes32 custody_signer;
        bytes32 bridge_config;
        bytes32 message;
        bytes32 emitter;
        bytes32 sequence;
        bytes32 fee_collector;
        bytes32 clock;
        bytes32 rent;
        bytes32 system;
        bytes32 token;
        bytes32 wormhole_core;
    }

    /// @notice Encodes a transfer_tokens instruction payload.
    /// @dev Layout: [tag:1][nonce:4 LE][amount:8 LE][fee:8 LE][target_address:32][target_chain:2 LE]
    function encodeTransferTokens(TransferParams memory p)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            TRANSFER_TOKENS_TAG,
            _u32le(p.nonce),
            _u64le(p.amount),
            _u64le(p.fee),
            p.targetAddress,
            _u16le(p.targetChain)
        );
    }

    /// @notice Builds the ordered account list for the transfer_tokens instruction.
    /// @dev Accepts a TransferAccounts struct to avoid stack-too-deep with 18 accounts.
    function buildAccounts(TransferAccounts memory a)
        internal
        pure
        returns (ICrossProgramInvocation.AccountMeta[] memory metas)
    {
        metas = new ICrossProgramInvocation.AccountMeta[](18);

        metas[0]  = ICrossProgramInvocation.AccountMeta(a.payer,            true,  true);   // payer
        metas[1]  = ICrossProgramInvocation.AccountMeta(a.config,           false, false);  // config
        metas[2]  = ICrossProgramInvocation.AccountMeta(a.from_owner,       true,  false);  // from_owner
        metas[3]  = ICrossProgramInvocation.AccountMeta(a.from,             false, true);   // from
        metas[4]  = ICrossProgramInvocation.AccountMeta(a.mint,             false, true);   // mint
        metas[5]  = ICrossProgramInvocation.AccountMeta(a.custody,          false, true);   // custody
        metas[6]  = ICrossProgramInvocation.AccountMeta(a.authority_signer, false, false);  // authority_signer
        metas[7]  = ICrossProgramInvocation.AccountMeta(a.custody_signer,   false, false);  // custody_signer
        metas[8]  = ICrossProgramInvocation.AccountMeta(a.bridge_config,    false, true);   // bridge_config
        metas[9]  = ICrossProgramInvocation.AccountMeta(a.message,          true,  true);   // message
        metas[10] = ICrossProgramInvocation.AccountMeta(a.emitter,          false, false);  // emitter
        metas[11] = ICrossProgramInvocation.AccountMeta(a.sequence,         false, true);   // sequence
        metas[12] = ICrossProgramInvocation.AccountMeta(a.fee_collector,    false, true);   // fee_collector
        metas[13] = ICrossProgramInvocation.AccountMeta(a.clock,            false, false);  // clock
        metas[14] = ICrossProgramInvocation.AccountMeta(a.rent,             false, false);  // rent
        metas[15] = ICrossProgramInvocation.AccountMeta(a.system,           false, false);  // system
        metas[16] = ICrossProgramInvocation.AccountMeta(a.token,            false, false);  // token
        metas[17] = ICrossProgramInvocation.AccountMeta(a.wormhole_core,    false, false);  // wormhole_core
    }

    // -------------------------------------------------------------------------
    // TransferWrapped — account layout for Wormhole-wrapped tokens
    // -------------------------------------------------------------------------

    /// @notice Aggregated account references for the transfer_wrapped instruction.
    /// @dev Differs from TransferAccounts: drops custody + custody_signer,
    ///      adds from_token_meta (wrapped_meta PDA) at index 4, reorders others.
    struct TransferWrappedAccounts {
        bytes32 payer;
        bytes32 config;
        bytes32 from;
        bytes32 from_owner;
        bytes32 from_token_meta;    // wrapped_meta PDA: [b"meta", mint] under Token Bridge
        bytes32 mint;
        bytes32 authority_signer;
        bytes32 bridge_config;      // Core bridge config
        bytes32 message;
        bytes32 emitter;
        bytes32 sequence;
        bytes32 fee_collector;
        bytes32 clock;
        bytes32 sender;             // signer — usually == from_owner for direct calls
        bytes32 rent;
        bytes32 system;
        bytes32 token;
        bytes32 wormhole_core;
    }

    /// @notice Builds the ordered account list for the transfer_wrapped instruction.
    /// @dev TransferWrapped account order per wormhole/solana/modules/token_bridge/
    ///      program/src/api/transfer.rs:
    ///      0  payer           signer, writable
    ///      1  config          readonly
    ///      2  from            writable (user ATA)
    ///      3  from_owner      signer   (user PDA)
    ///      4  from_token_meta readonly (wrapped_meta PDA)
    ///      5  mint            writable (wrapped mint)
    ///      6  authority_signer readonly
    ///      7  bridge_config   writable (Core bridge)
    ///      8  message         signer, writable
    ///      9  emitter         readonly
    ///      10 sequence        writable
    ///      11 fee_collector   writable
    ///      12 clock           readonly (Clock sysvar)
    ///      13 sender          signer
    ///      14 rent            readonly (Rent sysvar)
    ///      15 system          readonly (System program)
    ///      16 token           readonly (SPL Token program)
    ///      17 wormhole_core   readonly (Core program)
    function buildTransferWrappedAccounts(TransferWrappedAccounts memory a)
        internal
        pure
        returns (ICrossProgramInvocation.AccountMeta[] memory metas)
    {
        metas = new ICrossProgramInvocation.AccountMeta[](18);
        metas[0]  = ICrossProgramInvocation.AccountMeta(a.payer,            true,  true);   // payer
        metas[1]  = ICrossProgramInvocation.AccountMeta(a.config,           false, false);  // config
        metas[2]  = ICrossProgramInvocation.AccountMeta(a.from,             false, true);   // from (ATA)
        metas[3]  = ICrossProgramInvocation.AccountMeta(a.from_owner,       true,  false);  // from_owner
        metas[4]  = ICrossProgramInvocation.AccountMeta(a.from_token_meta,  false, false);  // wrapped_meta
        metas[5]  = ICrossProgramInvocation.AccountMeta(a.mint,             false, true);   // mint
        metas[6]  = ICrossProgramInvocation.AccountMeta(a.authority_signer, false, false);  // authority_signer
        metas[7]  = ICrossProgramInvocation.AccountMeta(a.bridge_config,    false, true);   // bridge_config
        metas[8]  = ICrossProgramInvocation.AccountMeta(a.message,          true,  true);   // message
        metas[9]  = ICrossProgramInvocation.AccountMeta(a.emitter,          false, false);  // emitter
        metas[10] = ICrossProgramInvocation.AccountMeta(a.sequence,         false, true);   // sequence
        metas[11] = ICrossProgramInvocation.AccountMeta(a.fee_collector,    false, true);   // fee_collector
        metas[12] = ICrossProgramInvocation.AccountMeta(a.clock,            false, false);  // clock
        metas[13] = ICrossProgramInvocation.AccountMeta(a.sender,           true,  false);  // sender
        metas[14] = ICrossProgramInvocation.AccountMeta(a.rent,             false, false);  // rent
        metas[15] = ICrossProgramInvocation.AccountMeta(a.system,           false, false);  // system
        metas[16] = ICrossProgramInvocation.AccountMeta(a.token,            false, false);  // token
        metas[17] = ICrossProgramInvocation.AccountMeta(a.wormhole_core,    false, false);  // wormhole_core
    }

    // -------------------------------------------------------------------------
    // Internal serialization helpers
    // -------------------------------------------------------------------------

    function _u16le(uint16 v) private pure returns (bytes memory) {
        bytes memory b = new bytes(2);
        b[0] = bytes1(uint8(v));
        b[1] = bytes1(uint8(v >> 8));
        return b;
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
