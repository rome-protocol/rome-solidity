// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ─────────────────────────────────────────────────────────────────────────────
// SCOPE: Rome precompile bindings ONLY.
//
// This file is a chain-ABI header — the Solidity projection of the rome-evm
// program's non-EVM dispatch table. It version-tracks the program: its only
// reason to change is a rome-evm program upgrade. It is the ONE file in this repo
// allowed to hardcode addresses, because precompile addresses (0xFF.., 0x42..)
// are protocol constants, invariant across every Rome chain.
//
// Admission rule: an interface belongs here IFF its address is a fixed constant
// burned into the program dispatch. Application contracts do NOT belong here —
// their addresses are per-chain and canonical in rome-protocol/registry.
//
//   • App-contract interfaces → each area's own file
//       (e.g. bridge/interfaces/IRomeBridgeWithdraw.sol, oracle/IExtendedOracleAdapter.sol)
//   • Deployed addresses      → rome-protocol/registry, never here
//   • Discovery map           → contracts/README.md
// ─────────────────────────────────────────────────────────────────────────────

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

// ─── Cached precompiles ──────────────────────────────────────────────
// Route through the the Rome EVM program journal so non-EVM side effects
// (SPL / ATA / System CPIs + Withdraw) are revertable alongside EVM
// diffs. The non-cached precompiles above (Withdraw at 0x42..16,
// System at 0xff..07, etc.) remain wired and continue to dispatch the
// legacy non-revertable path.
//
// Source of truth: the Rome EVM program's cached non-EVM dispatch.
// Selectors below were re-derived from canonical signatures via ethers
// `id(sig).slice(0,10)` against the Rust dispatch bytes — do not trust
// the inline `// 0x…` comments in the Rust source if they conflict.

interface IWithdrawCached {
    // 0x4d8b0ea4 — payable
    function withdrawal(bytes32 owner) payable external;
    // 0x7f3124a0
    function withdraw_to_pda(uint256 wei_) external;
    // 0x8059abc0
    function withdraw_to_ata(uint256 wei_) external;
    // 0xb6b55f25 — inverse of withdrawal; SPL transfer from caller's PDA-owned
    // ATA to chain's sol_wallet ATA on Solana side, mint `wei_` native gas to
    // caller on EVM side. Pure mint (no offsetting Withdraw::ADDRESS debit).
    // Single-state only. Cached counterpart of legacy
    // HelperProgram.deposit_from_ata; shipped in a Rome EVM program upgrade, renamed
    // from `withdraw_from_ata(uint256)` `0x214ee485` in a Rome EVM program upgrade
    // (post-ship accounting fix).
    function deposit(uint256 wei_) external;
}

interface ISystemCached {
    // 0xe0402a8d
    function create_pda() external;
    // 0x4ceab657 — lamports
    function create_pda(uint64 lamports) external;
    // 0x48e2bb86 — lamports, salt
    function create_pda(uint64 lamports, bytes32 salt) external;
    // 0xcc258bbf — owner, len, salt
    function create_pda(bytes32 owner, uint64 len, bytes32 salt) external;
    // 0x93225c9f — len, salt
    function allocate(uint64 len, bytes32 salt) external;
    // 0x8ac00bdc — owner, salt
    function assign(bytes32 owner, bytes32 salt) external;
    // 0x5d359fbd — to, lamports
    function transfer(address to, uint64 lamports) external;
    // 0xfd54d1ea — to_pda, lamports
    function transfer(bytes32 to, uint64 lamports) external;
    // 0x875abfc0 — to_pda, lamports, salt
    function transfer(bytes32 to, uint64 lamports, bytes32 salt) external;
}

interface ISplCached {
    enum AccountState {
        Uninitialized,
        Initialized,
        Frozen
    }
    struct Account {
        bytes32 mint;
        bytes32 owner;
        uint64 amount;
        bytes32 delegate;
        AccountState state;
        bool is_native;
        uint64 native_value;
        uint64 delegated_amount;
        bytes32 close_authority;
    }
    // 0xa9059cbb — IERC20.transfer
    function transfer(address to, uint256 amount) external;
    // 0x6a467394 — to_pda, amount
    function transfer(bytes32 to_pda, uint256 amount) external;
    // 0x57cfeeee — to, amount, mint
    function transfer(address to, uint256 amount, bytes32 mint) external;
    // 0x7db527f9 — to_pda, amount, mint
    function transfer(bytes32 to_pda, uint256 amount, bytes32 mint) external;
    // 0x401e3367 — delegate variant; authority = external_auth(caller),
    // accepted as the from-ATA's owner OR a sufficient-amount delegate.
    // Consumed by SPL_ERC20_cached.transferFrom + router-driven flows.
    // Shipped in a Rome EVM program upgrade.
    function transferFrom(address from, address to, uint256 amount, bytes32 mint) external;
    // 0x8180f2fc — EVM-spender approve. owner = external_auth(caller),
    // delegate = external_auth(spender). Shipped in a Rome EVM program upgrade.
    function approve(address spender, uint256 amount, bytes32 mint) external;
    // 0x1e458bee — caller-PDA signs as the mint authority (SPL runtime
    // enforces match). Consumed by SPL_ERC20_cached.mint_to + inbound bridge
    // settle. Shipped in a Rome EVM program upgrade.
    function mint(address to, uint256 amount, bytes32 mint) external;
    // 0x0b0ad508 — ata, mint, owner
    function init(bytes32 ata, bytes32 mint, bytes32 owner) external;
    // 0x73b9aa91 — derives ATA(external_auth(user), chain_mint) internally
    function account(address user) external view returns(Account memory);
    // 0x882358ae — raw 32-byte ATA pubkey
    function account(bytes32 ata) external view returns(Account memory);
    // 0xf9827227 — derives ATA(external_auth(user), mint) internally for an
    // arbitrary mint; mirror of account(address) with an explicit mint.
    function account(address user, bytes32 mint) external view returns(Account memory);

    // 0xe24bf5d4 — mint facts, ARMED not merely present.
    // hookProgram and feeBps are zero when the extension is absent OR present
    // and inert (a zero hook program_id fires no CPI; zero bps skips the fee
    // path), so `hookProgram != 0` is the question worth asking. `extensions`
    // reports presence, bit N per ExtensionType discriminant N.
    function mint_info(bytes32 mint) external view returns (
        bytes32 tokenProgram,
        uint8 decimals,
        bytes32 hookProgram,
        uint16 feeBps,
        uint32 extensions
    );
}

interface IAssociatedSplCached {
    // 0xb6d336ed
    function create_ata() external;
    // 0x81972e35 — mint
    function create_ata(bytes32 mint) external;
    // 0x5a7c3259 — user (same selector as IHelperProgram.create_ata(address))
    function create_ata(address user) external;
    // 0x3de2251a — user, mint (same selector as IHelperProgram.create_ata(address,bytes32))
    function create_ata(address user, bytes32 mint) external;
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

    // ─── CU-shortcut precompiles (a Rome EVM program upgrade + #319) ──────
    // Canonical keccak256(sig)[..4] selectors landed via PR #320. See
    // the precompile reference (v1) and
    // the precompile reference (v2) for design rationale + measured
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
    // create_ata_for_key — idempotent ATA-create for an arbitrary raw Solana
    // pubkey owner (NOT derived via external_auth from an EVM address).
    // Operator pays rent. Used for raw-pubkey recipients in
    // SPL_ERC20.bridgeOutToSolana / ensureRecipientAta / create_token_account
    // (replaces the prior AssociatedSplToken + CpiProgram.invoke marshaling).
    // Shipped in a Rome EVM program upgrade.
    function create_ata_for_key(bytes32 wallet, bytes32 mint) external;
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
    // transfer_spl_to_signer — return SPL to the outer Solana tx signer's own
    // ATA. Source = ata(external_auth(caller), mint); destination =
    // ata(signer, mint), where signer is the Solana keypair that signed the
    // Rome tx (the real user wallet, not a PDA). Signs as external_auth(caller).
    // The return leg for Solana-native users (do_tx_unsigned / activate_ata
    // flow): moves rome-evm_user_ata -> user_ata for any mint. Selector 0x46efa679.
    function transfer_spl_to_signer(uint64 amount, bytes32 mint) external;
    // approve_spl — caller-PDA-as-owner sets delegate_pda(spender) on the
    // owner-ATA via SPL approve_checked. Replaces v1 SPL_ERC20.approve's
    // SplTokenLib.approve + raw invoke_signed marshaling path. Signs as
    // external_auth(caller).
    function approve_spl(address spender, uint64 amount, bytes32 mint) external;
    // approve_spl_raw_delegate — SPL approve_checked with a caller-supplied
    // raw Solana pubkey as delegate (e.g. Wormhole authority_signer PDA, no
    // EVM-address equivalent). Caller passes uint8 decimals to skip the
    // on-chain mint read (~30-50K CU saving). spl_program hardcoded to SPL
    // Token. Signer = external_auth(caller). Shipped in PR #364; consumed
    // by RomeBridgeWithdraw.approveBurnETH.
    function approve_spl_raw_delegate(bytes32 src_ata, bytes32 delegate, uint64 amount, bytes32 mint, uint8 decimals) external;
    // mint_spl — caller-PDA-as-mint-authority mints to dest user's ATA
    // via SPL mint_to_checked. SPL Token runtime enforces caller-PDA ==
    // on-chain mint authority. Replaces v1 SPL_ERC20.mint_to's
    // SplTokenLib.mint_to_checked + raw invoke marshaling path.
    function mint_spl(address to, uint64 amount, bytes32 mint) external;
    // Token-2022 4-arg overloads (`approve_spl(...,token_program)` `0xc9884b1e`,
    // `mint_spl(...,token_program)` `0x406ee21b`,
    // `transfer_spl(...,token_program)` `0x7b11c48f`) were removed in
    // a Rome EVM program upgrade — their impls still called mint_owner_decimals,
    // defeating the explicit token_program argument and delivering zero CU
    // saving vs the 3-arg variants. Token-2022 raw-delegate flows will get
    // fresh selectors with proper plumbing when use cases emerge.
    // create_mint_account — System CreateAccount for a salt-derived PDA with
    // space=82 (SPL_MINT_LEN), owner=SPL Token, lamports=rent-floor. Funder =
    // caller's external_auth PDA. New account = external_auth_with_salt(caller, salt).
    // Two PDA signers (funder + new mint). Consumed by ERC20SPLFactory.create_token_mint.
    // Shipped in a Rome EVM program upgrade (selector 0xe97d3291).
    function create_mint_account(bytes32 salt) external;
    // init_spl_mint — SPL Token InitializeMint2 against a pre-allocated mint
    // account. No PDA signer needed (mint_authority + freeze_authority stored
    // as account data, not runtime signers). Consumed by ERC20SPLFactory.init_token_mint.
    // Shipped in a Rome EVM program upgrade (selector 0x4f75e987).
    function init_spl_mint(bytes32 mint, uint8 decimals, bytes32 mint_authority, bool has_freeze_authority, bytes32 freeze_authority) external;
    // create_and_init_mint — Composed: System CreateAccount + SPL InitializeMint2
    // in one dispatch. Saves one Rome DoTx envelope + one Solidity delegatecall
    // vs calling create_mint_account + init_spl_mint separately. Optional
    // one-call flow for callers that prefer it. Shipped in the Rome EVM program
    // PR #364 (selector 0x20972d0f).
    function create_and_init_mint(uint8 decimals, bytes32 mint_authority, bool has_freeze_authority, bytes32 freeze_authority, bytes32 salt) external;
    // external pda
    function pda(address user) external view returns (bytes32);
    // pda_with_salt — salt-derived EXTERNAL_AUTHORITY PDA in one dispatch.
    // Collapses the Solidity-side 2-call composition
    // (rome_evm_program_id() + find_program_address(seeds)). Used by
    // RomeEVMAccount.pda_with_salt (called by RomeBridgeWithdraw.burnUSDC /
    // burnETH for the CCTP messageSentEventData / Wormhole messageAccount
    // PDA derivations). Shipped in PR #364.
    function pda_with_salt(address user, bytes32 salt) external view returns (bytes32);
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

    // 0xe24bf5d4 — mint facts, ARMED not merely present.
    // hookProgram and feeBps are zero when the extension is absent OR present
    // and inert (a zero hook program_id fires no CPI; zero bps skips the fee
    // path), so `hookProgram != 0` is the question worth asking. `extensions`
    // reports presence, bit N per ExtensionType discriminant N.
    function mint_info(bytes32 mint) external view returns (
        bytes32 tokenProgram,
        uint8 decimals,
        bytes32 hookProgram,
        uint16 feeBps,
        uint32 extensions
    );
    // deposit gas-token from ata
    function deposit_from_ata(uint256 wei_) external;
}

address constant system_cached_address = address(0xFf00000000000000000000000000000000000004);
address constant spl_cached_address = address(0xff00000000000000000000000000000000000005);
address constant associated_spl_cached_address = address(0xFF00000000000000000000000000000000000006);
address constant system_program_address = address(0xfF00000000000000000000000000000000000007);
address constant cpi_program_address = address(0xFF00000000000000000000000000000000000008);
address constant helper_program_address = address(0xff00000000000000000000000000000000000009);
address constant withdraw_cached_address = address(0xFF0000000000000000000000000000000000000B);
address constant withdraw_address = address(0x4200000000000000000000000000000000000016);

ISystemProgram constant SystemProgram = ISystemProgram(system_program_address);
ICrossProgramInvocation constant CpiProgram = ICrossProgramInvocation(cpi_program_address);
IWithdraw constant Withdraw = IWithdraw(withdraw_address);
IHelperProgram constant HelperProgram = IHelperProgram(helper_program_address);
ISystemCached constant SystemCached = ISystemCached(system_cached_address);
ISplCached constant SplCached = ISplCached(spl_cached_address);
IAssociatedSplCached constant AssociatedSplCached = IAssociatedSplCached(associated_spl_cached_address);
IWithdrawCached constant WithdrawCached = IWithdrawCached(withdraw_cached_address);





