// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ICrossProgramInvocation} from "../interface.sol";

/// @title CCTPLib
/// @notice Encodes deposit_for_burn instructions and account lists for the Circle CCTP
///         Token Messenger program, to be invoked via Rome's CPI precompile.
library CCTPLib {
    /// @dev Placeholder — replaced at deploy time by the base58-decoded pubkey of
    ///      CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3
    bytes32 internal constant TOKEN_MESSENGER_PROGRAM =
        0x0000000000000000000000000000000000000000000000000000000000000002;

    /// @dev Placeholder — replaced at deploy time by the base58-decoded pubkey of
    ///      CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd
    bytes32 internal constant MESSAGE_TRANSMITTER_PROGRAM =
        0x0000000000000000000000000000000000000000000000000000000000000003;

    uint32 internal constant DOMAIN_ETHEREUM = 0;
    uint32 internal constant DOMAIN_SOLANA   = 5;

    /// @dev Anchor discriminator for deposit_for_burn — verify against live IDL at deploy time.
    bytes8 internal constant DISCRIMINATOR_DEPOSIT_FOR_BURN = 0x6d8ab0e1d8a34c4e;

    /// @notice Parameters for the deposit_for_burn instruction.
    struct DepositForBurnParams {
        uint64 amount;
        uint32 destinationDomain;
        bytes32 mintRecipient;
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

    /// @notice Builds the ordered account list for the deposit_for_burn instruction.
    /// @param sender                      User PDA — signer, mutable
    /// @param burn_token_mint             SPL mint to burn — mutable
    /// @param burn_token_account          User's SPL token account — mutable
    /// @param message_transmitter_config  Message Transmitter config PDA — mutable
    /// @param token_messenger_config      Token Messenger config PDA — readonly
    /// @param remote_token_messenger      Remote chain token messenger PDA — readonly
    /// @param token_minter                Token Minter PDA — mutable
    /// @param local_token                 Local token PDA — mutable
    /// @param message_sent_event_data     Event data account — signer, mutable
    /// @param token_program               SPL Token program — readonly
    /// @param system_program              System program — readonly
    /// @param event_authority             Anchor event authority PDA — readonly
    /// @param program                     Token Messenger program itself — readonly
    function buildDepositForBurnAccounts(
        bytes32 sender,
        bytes32 burn_token_mint,
        bytes32 burn_token_account,
        bytes32 message_transmitter_config,
        bytes32 token_messenger_config,
        bytes32 remote_token_messenger,
        bytes32 token_minter,
        bytes32 local_token,
        bytes32 message_sent_event_data,
        bytes32 token_program,
        bytes32 system_program,
        bytes32 event_authority,
        bytes32 program
    )
        internal
        pure
        returns (ICrossProgramInvocation.AccountMeta[] memory metas)
    {
        metas = new ICrossProgramInvocation.AccountMeta[](13);

        metas[0]  = ICrossProgramInvocation.AccountMeta(sender,                      true,  true);   // sender
        metas[1]  = ICrossProgramInvocation.AccountMeta(burn_token_mint,             false, true);   // burn_token_mint
        metas[2]  = ICrossProgramInvocation.AccountMeta(burn_token_account,          false, true);   // burn_token_account
        metas[3]  = ICrossProgramInvocation.AccountMeta(message_transmitter_config,  false, true);   // message_transmitter_config
        metas[4]  = ICrossProgramInvocation.AccountMeta(token_messenger_config,      false, false);  // token_messenger_config
        metas[5]  = ICrossProgramInvocation.AccountMeta(remote_token_messenger,      false, false);  // remote_token_messenger
        metas[6]  = ICrossProgramInvocation.AccountMeta(token_minter,                false, true);   // token_minter
        metas[7]  = ICrossProgramInvocation.AccountMeta(local_token,                 false, true);   // local_token
        metas[8]  = ICrossProgramInvocation.AccountMeta(message_sent_event_data,     true,  true);   // message_sent_event_data
        metas[9]  = ICrossProgramInvocation.AccountMeta(token_program,               false, false);  // token_program
        metas[10] = ICrossProgramInvocation.AccountMeta(system_program,              false, false);  // system_program
        metas[11] = ICrossProgramInvocation.AccountMeta(event_authority,             false, false);  // event_authority
        metas[12] = ICrossProgramInvocation.AccountMeta(program,                     false, false);  // program
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
