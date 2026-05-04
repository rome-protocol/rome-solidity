// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SplTokenLib} from "../spl_token/spl_token.sol";
import {AssociatedSplToken} from "../spl_token/associated_spl_token.sol";
import {ISystemProgram, ICrossProgramInvocation, CpiProgram} from "../interface.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";
import {UserPda} from "../cpi/UserPda.sol";
import {Convert} from "../convert.sol";

contract ERC20Users {
    bytes32 public payer_salt = Convert.bytes_to_bytes32(bytes("PAYER"));

    mapping (address => bytes32) private users;

    function ensure_user(address user) public returns (bytes32) {
        bytes32 existing_user = users[user];
        if (existing_user == bytes32(0)) {
            bytes32 new_user = RomeEVMAccount.get_payer(user, payer_salt);
            users[user] = new_user;
            return new_user;
        } else {
            return existing_user;
        }
    }

    function get_user(address user) public view returns (bytes32) {
        bytes32 existing_user = users[user];
        require(existing_user != bytes32(0), "User does not exist");
        return existing_user;
    }
}

contract SPL_ERC20 is IERC20, IERC20Metadata {
    // SystemProgram
    bytes32 public constant system_program_id = 0x0000000000000000000000000000000000000000000000000000000000000000;
    // ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
    bytes32 public constant associated_token_program_id = 0x8c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f859;

    address public immutable cpi_program;
    bytes32 public immutable mint_id;
    uint8 public immutable decimals;

    string private _name;
    string private _symbol;
    ERC20Users private _users;
    mapping(address => bytes32) private _accounts;

    /// @notice Canonical SPL token account address for `user` against this
    /// wrapper's mint.
    /// @dev Pure derivation. Returns
    /// `ata(AUTHORITY_PDA(user), mint_id, splTokenProgram)` — same ATA
    /// `balanceOf` reads (line below at 158) and same destination
    /// `wrap_gas_to_spl` deposits to and Wormhole `complete_transfer_wrapped`
    /// lands at. Always non-zero, no per-user activation required.
    ///
    /// Pre-#82 this returned `_accounts[user]` (a PAYER_PDA-owned ATA cached
    /// on first wrapper-mediated call). After #82 migrated `balanceOf` to
    /// the AUTHORITY_PDA-derived ATA, this reader stayed on the legacy
    /// mapping — internally inconsistent: `balanceOf(user)` could return a
    /// non-zero amount while `getAta(user)` returned `bytes32(0)` for any
    /// user whose tokens arrived via wrap / inbound bridge (which never
    /// write to `_accounts`). RomeBridgeWithdraw consumed this reader for
    /// the CCTP / Wormhole burn account; the inconsistency surfaced as
    /// `mollusk error: Failure(Custom(3007))` from CCTP's depositForBurn
    /// when fed an empty-or-zero burnTokenAccount.
    function getAta(address user) external view returns (bytes32) {
        return UserPda.ata(user, mint_id);
    }

    error ERC20InvalidApprover(address approver);
    error ERC20InvalidSpender(address spender);
    error ERC20InsufficientAllowance(address spender, uint256 currentAllowance, uint256 requiredAllowance);

    constructor(
        bytes32 _mint_id, 
        address _cpi_program, 
        string memory name_, 
        string memory symbol_,
        ERC20Users users_
    ) {
        SplTokenLib.SplMint memory mint = SplTokenLib.load_mint(_mint_id, _cpi_program);

        cpi_program = _cpi_program;
        mint_id = _mint_id;
        decimals = mint.decimals;
        _name = name_;
        _symbol = symbol_;
        _users = users_;
    }

    /**
     * Helper function to create an associated token account for a user if it doesn't exist, and return the associated token account address.
     * @param user EVM address of the user for whom to create the associated token account
     * @return associated_account_address The address of the associated token account created or existing for the user
     */
    function create_token_account(address user, bytes32 payer) public returns(bytes32) {
        bytes32 new_user = _users.ensure_user(user);
        (bytes32 program_id, ICrossProgramInvocation.AccountMeta[] memory accounts, bytes memory data, bytes32 associated_account_address) = 
            AssociatedSplToken.create_associated_token_account_idempotent(
                payer,
                new_user,
                mint_id, 
                system_program_id,
                SplTokenLib.SPL_TOKEN_PROGRAM,
                associated_token_program_id
            );
        
        bytes32[] memory seeds = new bytes32[](1);
        seeds[0] = _users.payer_salt();
        (bool success, bytes memory result) = address(cpi_program).delegatecall(
            abi.encodeWithSignature(
                "invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])",
                program_id, accounts, data, seeds
            )
        );

        require (success, string(Convert.revert_msg(result)));
        _accounts[user] = associated_account_address;
        return associated_account_address;
    }

    /**
     * Checks if the user has an associated token account, and if not, creates one. Returns the associated token account address.
     * @param user EVM address of the user for whom to ensure the associated token account exists
     * @return associated_account_address The address of the associated token account created or existing for the user
     */
    function ensure_token_account(address user) public returns (bytes32) {
        // ensure_user (not get_user) so a brand-new caller — never
        // bridged, never wrapped, never registered in ERC20Users — gets
        // auto-registered on the first call. Self-bootstrapping; no
        // out-of-band setup tx required. Idempotent for repeat callers.
        bytes32 payer = _users.ensure_user(msg.sender);
        bytes32 token_account = _accounts[user];
        if (token_account == bytes32(0)) {
            return create_token_account(user, payer);
        } else {
            return token_account;
        }
    }

    /**
     * Gets the associated token account address for a user. Reverts if the user does not have an associated token account.
     * @param user EVM address of the user whose associated token account address to retrieve
     * @return associated_account_address The address of the associated token account for the user
     */
    function get_token_account(address user) public view returns (bytes32) {
        bytes32 token_account = _accounts[user];
        require(token_account != bytes32(0), "Token account does not exist");
        return token_account;
    }

    function name() public view virtual returns (string memory) {
        return _name;
    }

    function symbol() public view virtual returns (string memory) {
        return _symbol;
    }

    function totalSupply() public view virtual returns (uint256) {
        SplTokenLib.SplMint memory mint = SplTokenLib.load_mint(mint_id, cpi_program);
        return uint256(mint.supply);
    }

    function balanceOf(address account) public view virtual returns (uint256) {
        // Always read AUTHORITY_PDA's ATA — that's the canonical
        // cross-chain location where bridged-in SPL tokens live
        // (Wormhole's complete_transfer_wrapped, useNativeDepositSend,
        // any inbound flow). Same source bridgeOutToSolana spends from.
        // Falling back to the legacy _accounts mapping (which was
        // populated only after a wrapper-mediated `ensure_token_account`
        // call) would mismatch and report 0 for any user whose tokens
        // arrived via a non-wrapper path.
        bytes32 ata = UserPda.ata(account, mint_id);
        return uint256(SplTokenLib.load_token_amount(ata, cpi_program));
    }

    function transfer(address to, uint256 value) public virtual returns (bool) {
        return _transfer(msg.sender, to, value);
    }

    /// @dev Idempotent: ensures `UserPda.ata(user, mint_id)` (the
    /// AUTHORITY_PDA-owned ATA) exists on Solana. Skips the create CPI
    /// when the account already exists — single-CPI fast path. Pays
    /// rent (when needed) from the supplied PAYER_PDA. Used as the
    /// recipient-side prepare in `_transfer` and `mint_to`.
    ///
    /// The early-return matters: `_transfer` in the direct path signs
    /// the SPL transfer as AUTHORITY_PDA (empty seeds) while the
    /// ATA-create signs as PAYER_PDA (`[payer_salt]` seeds). Two
    /// different signers in one Rome DoTx hits the same emulator
    /// quirk that forced `bridgeOutToSolana` to skip in-tx ATA-create
    /// (see comment at line ~342). Skipping the create CPI when the
    /// ATA is already there avoids the multi-signer scenario entirely
    /// for the common case (returning recipients, all DEX/router
    /// flows after the first deposit).
    function _ensureAuthorityAta(address user, bytes32 payer)
        internal
        returns (bytes32)
    {
        bytes32 owner = UserPda.pda(user);
        bytes32 to_ata = UserPda.ataForKey(owner, mint_id);
        (,,,,, bytes memory existing) = ICrossProgramInvocation(cpi_program).account_info(to_ata);
        if (existing.length > 0) {
            return to_ata;
        }
        (
            bytes32 program_id,
            ICrossProgramInvocation.AccountMeta[] memory accounts,
            bytes memory data,
        ) = AssociatedSplToken.create_associated_token_account_idempotent(
            payer,
            owner,
            mint_id,
            system_program_id,
            SplTokenLib.SPL_TOKEN_PROGRAM,
            associated_token_program_id
        );
        bytes32[] memory seeds = new bytes32[](1);
        seeds[0] = _users.payer_salt();
        (bool success, bytes memory result) = address(cpi_program).delegatecall(
            abi.encodeWithSignature(
                "invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])",
                program_id, accounts, data, seeds
            )
        );
        require(success, string(Convert.revert_msg(result)));
        return to_ata;
    }

    /// Internal SPL transfer. Source = AUTHORITY_PDA(from)'s ATA — the
    /// canonical cross-chain balance location (where Wormhole
    /// `complete_transfer_wrapped`, native deposits, and `wrap_gas_to_spl`
    /// land tokens; what `balanceOf` and `getAta` read). Authority depends
    /// on caller context:
    ///   * Direct path (`msg.sender == from`): sign as AUTHORITY_PDA(from)
    ///     with empty seeds — same auth model as `bridgeOutToSolana`.
    ///   * Delegated path (`msg.sender != from` — `transferFrom`): sign as
    ///     PAYER_PDA(spender) (the delegate set by `approve`) with
    ///     `[payer_salt]` seeds. SPL token program recognizes the signer
    ///     as a delegate via the source account's delegate field and
    ///     auto-decrements `delegated_amount`.
    ///
    /// Recipient ATA is the AUTHORITY_PDA(to)-owned ATA. Idempotent
    /// create runs only if the ATA is missing. Sender's PAYER_PDA pays
    /// rent — same Phantom-like UX as the prior `ensure_token_account`
    /// path.
    ///
    /// Pre-#82 this used the `_accounts` mapping (PAYER_PDA-owned ATA
    /// cached on first wrapper-mediated call). Post-#82 `balanceOf` /
    /// `getAta` migrated to AUTHORITY_PDA's ATA, but `_transfer` /
    /// `approve` / `transferFrom` stayed on the legacy `_accounts`
    /// mapping — internally inconsistent. A user with bridged-in
    /// balance saw a non-zero `balanceOf` but `approve` / `transferFrom`
    /// failed inside Solana with `mollusk error: Failure(Custom(1))`
    /// because the legacy ATA had zero balance. This commit closes
    /// that gap; standard ERC20 `approve` + `transferFrom` works for
    /// any user whose tokens are in their canonical AUTHORITY_PDA ATA.
    function _transfer(address from, address to, uint256 value) internal returns (bool) {
        require(value <= type(uint64).max, "Transfer amount exceeds uint64");

        bytes32 from_authority_pda = UserPda.pda(from);
        bytes32 from_ata = UserPda.ataForKey(from_authority_pda, mint_id);

        bytes32 sender_payer_pda = _users.ensure_user(msg.sender);
        bytes32 to_ata = _ensureAuthorityAta(to, sender_payer_pda);

        bytes32 authority;
        bytes32[] memory seeds;
        if (msg.sender == from) {
            authority = from_authority_pda;
            seeds = new bytes32[](0);
        } else {
            authority = sender_payer_pda;
            seeds = new bytes32[](1);
            seeds[0] = _users.payer_salt();
        }

        (bytes32 program_id, ICrossProgramInvocation.AccountMeta[] memory accounts, bytes memory data) =
        SplTokenLib.transfer_checked(
            SplTokenLib.SPL_TOKEN_PROGRAM,
            from_ata,
            mint_id,
            to_ata,
            authority,
            new bytes32[](0),
            uint64(value),
            decimals
        );

        (bool success, bytes memory result) = address(cpi_program).delegatecall(
            abi.encodeWithSignature(
                "invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])",
                program_id, accounts, data, seeds
            )
        );
        require(success, string(Convert.revert_msg(result)));
        emit Transfer(from, to, value);
        return true;
    }

    /// @dev View — never reverts. Returns 0 when spender has no
    /// allowance OR the owner's ATA doesn't exist yet. Reads the
    /// SPL delegate field on AUTHORITY_PDA(owner)'s ATA (the canonical
    /// balance ATA, post write-path migration). Spender's expected
    /// delegate pubkey is derived deterministically as
    /// `RomeEVMAccount.get_payer(spender, payer_salt)` — no
    /// state-write to `ERC20Users` is needed for a view function.
    function allowance(address owner, address spender) public view virtual returns (uint256) {
        bytes32 spender_payer_pda = RomeEVMAccount.get_payer(spender, _users.payer_salt());
        bytes32 owner_ata = UserPda.ata(owner, mint_id);
        (,,,,, bytes memory acct_data) = ICrossProgramInvocation(cpi_program).account_info(owner_ata);
        if (acct_data.length == 0) {
            return uint256(0);
        }
        (bytes32 delegate, uint64 delegated_amount) =
                            SplTokenLib.load_token_account_delegate(owner_ata, cpi_program);
        if (delegate != spender_payer_pda) {
            return uint256(0);
        }
        return uint256(delegated_amount);
    }

    /// SPL approve on the AUTHORITY_PDA(msg.sender)-owned ATA (where
    /// the user's tokens actually live). Delegate = PAYER_PDA(spender)
    /// — the address `transferFrom` will sign as. Owner +
    /// authority-signer = AUTHORITY_PDA(msg.sender), signed with empty
    /// seeds (same pattern as `bridgeOutToSolana`).
    function approve(address spender, uint256 value) public virtual returns (bool) {
        require(value <= type(uint64).max, "Approve amount exceeds uint64");
        // Register both parties in ERC20Users so other consumers
        // (including `transferFrom`) and any future allowance-reader
        // helpers see consistent PAYER PDAs. Idempotent.
        _users.ensure_user(msg.sender);
        bytes32 spender_payer_pda = _users.ensure_user(spender);

        bytes32 owner_authority_pda = UserPda.pda(msg.sender);
        bytes32 owner_ata = UserPda.ataForKey(owner_authority_pda, mint_id);

        (bytes32 program_id, ICrossProgramInvocation.AccountMeta[] memory accounts, bytes memory data) =
        SplTokenLib.approve(
            SplTokenLib.SPL_TOKEN_PROGRAM,
            owner_ata,
            spender_payer_pda,
            owner_authority_pda,
            new bytes32[](0),
            uint64(value)
        );

        bytes32[] memory seeds = new bytes32[](0); // sign as AUTHORITY_PDA
        (bool success, bytes memory result) = address(cpi_program).delegatecall(
            abi.encodeWithSignature(
                "invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])",
                program_id, accounts, data, seeds
            )
        );
        require(success, string(Convert.revert_msg(result)));
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) public virtual returns (bool) {
        return _transfer(from, to, value);
    }

    /// @notice Move this wrapper's underlying SPL out of the caller's
    /// PDA-owned ATA to an arbitrary Solana wallet. Generic Rome →
    /// Solana exit door for ANY wrapper deployed by the factory —
    /// works the same for WUSDC, WETH, WSOL, JUP, BONK, custom long-tail
    /// tokens. No Wormhole, no CCTP, no per-asset bridge contract: just
    /// an SPL transfer_checked CPI signed by the caller's authority PDA.
    ///
    /// Asymmetry vs. the EVM-side `transfer(address, uint256)`:
    ///   - `to` is a raw Solana wallet pubkey, NOT derived from an EVM
    ///     address. The recipient does not need a Rome account.
    ///   - The recipient's ATA for this wrapper's mint is created
    ///     idempotently if missing — the caller's PAYER PDA pays the
    ///     ~0.002 SOL rent (matches Phantom's "send to fresh address"
    ///     model). For repeat sends to the same recipient, the create
    ///     is a no-op.
    ///
    /// Behavior:
    ///   - The wrapper's `balanceOf(msg.sender)` decreases by `value`
    ///     since balanceOf reads the underlying SPL token account.
    ///   - The Solana recipient's wallet shows `value` of the underlying
    ///     SPL after this tx confirms.
    ///   - For wSOL specifically (canonical mint
    ///     So11111111111111111111111111111111111111112), the recipient
    ///     can `close_account` on their wSOL ATA in a follow-up Solana
    ///     tx to convert the SPL back to native lamports.
    ///
    /// @param solana_recipient The receiving wallet pubkey on Solana.
    ///        Recipient ATA = ata(solana_recipient, mint_id, spl_token).
    /// @param value Amount in this wrapper's smallest unit (must fit u64).
    /// @return success Always returns true on success; reverts otherwise.
    function bridgeOutToSolana(bytes32 solana_recipient, uint256 value)
        public
        virtual
        returns (bool)
    {
        require(value <= type(uint64).max, "Bridge amount exceeds uint64");
        require(solana_recipient != bytes32(0), "Solana recipient cannot be zero");

        // Two distinct PDAs are involved:
        //   - AUTHORITY_PDA = find_program_address([EXTERNAL_AUTHORITY, evmAddr])
        //     Owns the user's bridged-in SPL tokens. Wormhole's
        //     complete_transfer_wrapped, useNativeDepositSend, and
        //     other inbound paths all deposit to ata(AUTHORITY_PDA).
        //   - PAYER_PDA     = find_program_address([EXTERNAL_AUTHORITY, evmAddr, "PAYER"])
        //     Pre-funded with 1 SOL on first factory.create_user; pays
        //     rent for new ATA creations.
        //
        // For outbound bridging:
        //   - Source ATA   = ata(AUTHORITY_PDA, mint)  (where the user's
        //                    tokens actually live)
        //   - Funding for recipient ATA-create = PAYER_PDA (rent budget)
        //   - SPL transfer authority = AUTHORITY_PDA (matches source owner)
        //
        // The legacy `_users.get_user` mapping returns PAYER_PDA which is
        // the right answer for transfer-recipient ATAs (they're created
        // owned by PAYER_PDA via create_token_account), but the WRONG
        // answer for bridged-in tokens. bridgeOutToSolana takes the
        // direct path.
        bytes32 authority_pda = RomeEVMAccount.pda(msg.sender);
        // ensure_user (not get_user) so users who only have bridged-in
        // tokens (never called create_user) can still bridge out — the
        // first outbound auto-registers. payer_pda is read for
        // potential future ATA-create reintroduction (see comment below).
        bytes32 payer_pda = _users.ensure_user(msg.sender);

        bytes32 from_ata = UserPda.ataForKey(authority_pda, mint_id);

        // Recipient ATA — derive only. Caller must pre-create on Solana
        // if it doesn't exist. Adding the in-tx ATA-create CPI failed
        // on rome-evm's CPI emulator (the two-CPI sequence reverts at
        // sim time even though the contract logic is correct). Single
        // CPI (transfer only) works reliably on chain.
        bytes32 to_ata = UserPda.ataForKey(solana_recipient, mint_id);
        // Suppress unused-var warning. payer_pda is read for potential
        // future ATA-create reintroduction once the emulator quirk is
        // fixed.
        payer_pda;

        // SPL transfer_checked from AUTHORITY_PDA's ATA →
        // recipient's ATA. Authority = AUTHORITY_PDA (owns the source
        // ATA). Signed with empty seeds so the rome-evm CPI precompile
        // signs as AUTHORITY_PDA (no salt — find_program_address
        // ([EXTERNAL_AUTHORITY, evmAddr])).
        (
            bytes32 program_id,
            ICrossProgramInvocation.AccountMeta[] memory accounts,
            bytes memory data
        ) = SplTokenLib.transfer_checked(
            SplTokenLib.SPL_TOKEN_PROGRAM,
            from_ata,
            mint_id,
            to_ata,
            authority_pda,                  // owner of from_ata
            new bytes32[](0),
            uint64(value),
            decimals
        );

        bytes32[] memory transferSeeds = new bytes32[](0);

        (bool success, bytes memory result) = address(cpi_program).delegatecall(
            abi.encodeWithSignature(
                "invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])",
                program_id, accounts, data, transferSeeds
            )
        );
        require(success, string(Convert.revert_msg(result)));

        emit BridgedOutToSolana(msg.sender, solana_recipient, mint_id, value);
        return true;
    }

    /// @notice Emitted on every bridgeOutToSolana call. Indexers / activity
    /// feeds use this as the canonical "left Rome" signal — paired
    /// with on-chain Solana SPL transfer events for the round-trip.
    event BridgedOutToSolana(
        address indexed from,
        bytes32 indexed solana_recipient,
        bytes32 indexed mint_id,
        uint256 value
    );

    /// @notice Create the associated token account on Solana for a
    /// given recipient + this wrapper's mint. Pays rent from the
    /// caller's pre-funded PAYER PDA (no Solana wallet needed).
    ///
    /// Companion to `bridgeOutToSolana`. The single-CPI design of
    /// bridgeOutToSolana requires the recipient ATA to exist on
    /// Solana already; for first-time recipients the UI prompts the
    /// EVM user to sign this tx first, then the bridge tx. Two
    /// MetaMask popups, zero Phantom — same model as Wormhole's
    /// outbound `approveBurnETH` + `burnETH` pattern.
    ///
    /// Idempotent: returns the same ATA address whether it pre-existed
    /// or was created. Operators / hooks can probe Solana for existence
    /// first to skip this call when the ATA is already there.
    ///
    /// @param solana_recipient Wallet pubkey on Solana that will own
    ///        the new ATA.
    /// @return The recipient's ATA address (always
    ///         `ata(solana_recipient, mint_id, splTokenProgram)`).
    function ensureRecipientAta(bytes32 solana_recipient)
        public
        virtual
        returns (bytes32)
    {
        require(solana_recipient != bytes32(0), "Solana recipient cannot be zero");

        // ensure_user (not get_user) so users with bridged-in tokens
        // who never called create_user can still ensure recipient ATAs.
        bytes32 payer_pda = _users.ensure_user(msg.sender);

        (
            bytes32 program_id,
            ICrossProgramInvocation.AccountMeta[] memory accounts,
            bytes memory data,
            bytes32 to_ata
        ) = AssociatedSplToken.create_associated_token_account_idempotent(
            payer_pda,
            solana_recipient,
            mint_id,
            system_program_id,
            SplTokenLib.SPL_TOKEN_PROGRAM,
            associated_token_program_id
        );

        bytes32[] memory seeds = new bytes32[](1);
        seeds[0] = _users.payer_salt();

        (bool success, bytes memory result) = address(cpi_program).delegatecall(
            abi.encodeWithSignature(
                "invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])",
                program_id, accounts, data, seeds
            )
        );
        require(success, string(Convert.revert_msg(result)));

        emit RecipientAtaEnsured(msg.sender, solana_recipient, mint_id, to_ata);
        return to_ata;
    }

    /// @notice Emitted on every ensureRecipientAta call. Useful for
    /// off-chain tracking of which wallets have a sponsored ATA on
    /// which mint, so subsequent bridges can skip the create step.
    event RecipientAtaEnsured(
        address indexed funder_evm,
        bytes32 indexed solana_recipient,
        bytes32 indexed mint_id,
        bytes32 ata
    );

    function mint_to(address to, uint256 value) public virtual returns (bool) {
        require(value <= type(uint64).max, "Mint amount exceeds uint64");

        bytes32 user = _users.ensure_user(msg.sender);
        // Destination = AUTHORITY_PDA(to)'s ATA — the canonical ATA
        // `balanceOf(to)` reads. Pre-migration this minted into
        // PAYER_PDA(to)'s ATA, leaving the recipient's `balanceOf`
        // showing 0 even after a successful mint (the legacy `_accounts`
        // ATA wasn't where balance is read). Idempotent create — no-op
        // when the ATA already exists.
        bytes32 to_account = _ensureAuthorityAta(to, user);
        (bytes32 program_id, ICrossProgramInvocation.AccountMeta[] memory accounts, bytes memory data)
            = SplTokenLib.mint_to_checked(
            SplTokenLib.SPL_TOKEN_PROGRAM,
            mint_id,
            to_account,
            user,
            new bytes32[](0),
            uint64(value),
            decimals
        );

        bytes32[] memory seeds = new bytes32[](1);
        seeds[0] = _users.payer_salt();
        (bool success, bytes memory result) = address(cpi_program).delegatecall(
            abi.encodeWithSignature(
                "invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])",
                program_id, accounts, data, seeds
            )
        );

        require (success, string(Convert.revert_msg(result)));
        emit Transfer(address(0), to, value);
        return true;
    }
}
