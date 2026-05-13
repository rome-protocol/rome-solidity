// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ISystemProgram {
    struct Seed{
        bytes item;
    }
    // eth_calls
    function program_id() external view returns(bytes32);
    function rome_evm_program_id() external view returns(bytes32);
    function find_program_address(bytes32 program, Seed[] memory seeds) external pure returns (bytes32, uint8);
    function bytes32_to_base58(bytes32) external view returns(bytes memory);
    function base58_to_bytes32(bytes memory) external view returns(bytes32);
    function operator() external view returns(bytes32);
    function mint_id() external view returns(bytes32);
}

interface IWithdraw {
    function withdrawal(bytes32 owner) payable external;
    function withdraw_to_pda(uint256 wei_) external;
    function withdraw_to_ata(uint256 wei_) external;
}

interface ICrossProgramInvocation {
    struct AccountMeta {
        bytes32 pubkey;
        bool is_signer;
        bool is_writable;
    }
    struct Seed{
        bytes item;
    }
    struct PdaWithBump {
        bytes32 pda;
        uint8 bump;
    }
    function invoke(bytes32 program_id, AccountMeta[] memory accounts, bytes memory data) external;
    function invoke_signed(bytes32 program_id, AccountMeta[] memory accounts, bytes memory data, bytes32[] memory seeds) external;
    // return value: lamports, owner, is_signer, is_writable, executable, data
    function account_info(bytes32 pubkey) external view returns(uint64, bytes32, bool, bool, bool, bytes memory);

    // ─── CU-shortcut precompiles (rome-evm-private PR #318 + #319) ──────
    // Canonical keccak256(sig)[..4] selectors landed via PR #320. See
    // rome-evm-private/docs/CPI_PRECOMPILE_SHORTCUTS.md (v1) and
    // CPI_PRECOMPILE_SHORTCUTS_V2.md (v2) for design rationale + measured
    // CU savings.

    // Read a slice of any Solana account's data buffer.
    function account_data_at(bytes32 pubkey, uint16 offset, uint16 length) external view returns (bytes memory);
    // Read a u64 LE field at a known offset in a Solana account.
    function account_u64_at(bytes32 pubkey, uint16 offset) external view returns (uint64);
    // Lamports-only read — skips the data fetch.
    function account_lamports(bytes32 pubkey) external view returns (uint64);
    // Batch findPda — N independent PDAs against one program in one call.
    function pdas_batch_derive(bytes[][] memory seed_groups, bytes32 program_id) external view returns (PdaWithBump[] memory);
}
interface IHelperProgram {
    // create associated spl-token account owned by external pda. Gas token mint is used.
    // Is only applicable for rollup based on SPL-token.
    function create_ata(address user) external;
    // create associated spl-token account owned by external pda.
    function create_ata(address user, bytes32 mint) external;
    // create external pda
    function create_pda(address user) external;
    // create external pda with lamports
    function create_pda(address user, uint64 lamports) external;
    // swap gas-token to lamports (transfer from operator)
    function swap_gas_to_lamports(uint64 lamports) external;
    // transfer lamports between external pda
    function transfer_lamports(address to, uint64 lamports) external;
    // transfer spl-tokens between ata owned by external pda. Gas token mint is used.
    // Is only applicable for rollup based on SPL-token.
    function transfer_spl(address to, uint64 tokens) external;
    // transfer spl-tokens between ata owned by external pda. Gas token mint is used.
    // Is only applicable for rollup based on SPL-token.
    function transfer_spl(bytes32 to_ata, uint64 tokens) external;
    // transfer spl-tokens between ata owned by external pda.
    function transfer_spl(address to, uint64 tokens, bytes32 mint) external;
    // transfer spl-tokens between ata owned by external pda.
    function transfer_spl(bytes32 to_ata, uint64 tokens, bytes32 mint) external;
    // Delegate variant: src_ata is caller-supplied (the other transfer_spl
    // overloads derive it from external_auth(caller)). Signs as
    // external_auth(caller); SPL Token Program accepts this PDA as the
    // transfer_checked authority when it is the source ATA's owner OR its
    // delegate with delegated_amount >= tokens. Required by ERC20-style
    // transferFrom flows (e.g. SPL_ERC20._transfer with from != msg.sender).
    function transfer_spl(bytes32 src_ata, bytes32 to_ata, uint64 tokens, bytes32 mint) external;
    // external pda
    function pda(address user) external view returns (bytes32);
    // ata owned by external pda. Gas token mint is used.
    // Is only applicable for rollup based on SPL-token.
    function ata(address user) external view returns (bytes32);
    // ata owned by external pda.
    function ata(address user, bytes32 mint) external view returns (bytes32);
    // deposit gas-token from ata
    function deposit_from_ata(uint256 wei_) external; 
}

address constant system_program_address = address(0xfF00000000000000000000000000000000000007);
address constant cpi_program_address = address(0xFF00000000000000000000000000000000000008);
address constant helper_program_address = address(0xff00000000000000000000000000000000000009);
address constant withdraw_address = address(0x4200000000000000000000000000000000000016);

ISystemProgram constant SystemProgram = ISystemProgram(system_program_address);
ICrossProgramInvocation constant CpiProgram = ICrossProgramInvocation(cpi_program_address);
IWithdraw constant Withdraw = IWithdraw(withdraw_address);
IHelperProgram constant HelperProgram = IHelperProgram(helper_program_address);





