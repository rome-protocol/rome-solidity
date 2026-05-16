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
    // Addr-keyed delegate variant — both endpoints by EVM address.
    // Derives src_ata = ata(external_auth(from), mint) and
    // dst_ata = ata(external_auth(to), mint) internally. Signs as
    // external_auth(caller); SPL Token accepts PDA as owner OR delegate.
    // Distinct from the bytes32-ATA variant above (0x766b362a).
    // Replaces SPL_ERC20.transferFrom's delegate path.
    function transfer_spl(address from, address to, uint64 tokens, bytes32 mint) external;
    // approve_spl — caller-PDA-as-owner sets delegate_pda(spender) on the
    // owner-ATA via SPL approve_checked. Replaces v1 SPL_ERC20.approve's
    // SplTokenLib.approve + raw invoke_signed marshaling path. Signs as
    // external_auth(caller).
    function approve_spl(address spender, uint64 amount, bytes32 mint) external;
    // mint_spl — caller-PDA-as-mint-authority mints to dest user's ATA
    // via SPL mint_to_checked. SPL Token runtime enforces caller-PDA ==
    // on-chain mint authority. Replaces v1 SPL_ERC20.mint_to's
    // SplTokenLib.mint_to_checked + raw invoke marshaling path.
    function mint_spl(address to, uint64 amount, bytes32 mint) external;
    // Token-2022 4-arg overloads (`approve_spl(...,token_program)` `0xc9884b1e`,
    // `mint_spl(...,token_program)` `0x406ee21b`,
    // `transfer_spl(...,token_program)` `0x7b11c48f`) were removed in
    // rome-evm-private PR #364 — their impls still called mint_owner_decimals,
    // defeating the explicit token_program argument and delivering zero CU
    // saving vs the 3-arg variants. Token-2022 raw-delegate flows will get
    // fresh selectors with proper plumbing when use cases emerge.
    // external pda
    function pda(address user) external view returns (bytes32);
    // ata owned by external pda. Gas token mint is used.
    // Is only applicable for rollup based on SPL-token.
    function ata(address user) external view returns (bytes32);
    // ata owned by external pda.
    function ata(address user, bytes32 mint) external view returns (bytes32);
    // user_balance — read SPL TokenAccount.amount on user's PDA-owned
    // ATA. Returns 0 if ATA doesn't exist (fresh-chain probe; matches
    // v1 SPL_ERC20.balanceOf semantic). Collapses 3 v1 dispatches
    // (HelperProgram.ata + AccountReader.lamportsOf + AccountReader.readU64At)
    // into one CrossStateEthCall.
    function user_balance(address account, bytes32 mint) external view returns (uint64);
    // allowance_of — read owner-ATA's delegated_amount IFF on-chain
    // delegate matches external_auth(spender). Returns 0 otherwise.
    // HARD REQ for ERC-20 semantics: without the delegate-equality
    // check, routers see non-zero allowance for one spender while the
    // actual delegate is another, then transferFrom reverts. Collapses
    // 5 v1 dispatches into one.
    function allowance_of(address owner, address spender, bytes32 mint) external view returns (uint64);
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





