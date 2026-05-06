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
    mapping (address => bytes32) private users;

    /// 50M lamports (~0.05 SOL): bootstrap budget for the unified user
    /// PDA, sized to cover one outbound CCTP (~13M event-account rent)
    /// PLUS one outbound Wormhole (~2.5M message rent) PLUS several
    /// ATA-creates (~2M each, e.g. wrapper × wrapper pool sides) without
    /// manual top-up. Same constant as `ERC20SPLFactory.CREATE_PAYER_LAMPORTS`
    /// — kept in sync.
    ///
    /// History: previously 1M (rent-exempt floor only) under the
    /// pre-0acabea two-PDA model where the salted PAYER sub-PDA was
    /// funded separately. Under the unified-PDA model the same PDA
    /// signs CPIs AND pays rent, so an underfunded PDA blocks the
    /// first bridge tx (`mollusk Custom(1) =
    /// ResultWithNegativeLamports`) before the user can top up. Sizing
    /// up so the first-time-user UX matches the design principle's
    /// "Ethereum-equivalent" bar — Sepolia users don't get blocked on
    /// first bridge by a missing rent budget. Reclaim of CCTP event
    /// accounts is async (Circle relayer triggers it post-attestation),
    /// so back-to-back bridges before reclaim need the headroom.
    uint64 internal constant CREATE_PAYER_LAMPORTS = 50_000_000;

    /// @notice Idempotent registration + unified user PDA bootstrap.
    /// @dev On first call for `user`: writes the mapping AND funds the
    /// unified user PDA with 1M lamports — same dual side-effect as
    /// `factory.create_user()`. Repeat calls are no-ops (mapping write
    /// skipped if already set; `create_payer` short-circuits when the PDA
    /// already has ≥ requested lamports).
    ///
    /// History: the unified-PDA model landed in rome-solidity commit
    /// 0acabea ("Remove PAYER seed from user PDA derivation"). Before
    /// that, every EVM user had two distinct PDAs (AUTHORITY_PDA at
    /// `find_program_address([EXTERNAL_AUTHORITY, evmAddr])` plus
    /// PAYER_PDA at the same seed list with `"PAYER"` appended) which
    /// caused split-brain bugs — bridged-in tokens landed in
    /// AUTHORITY_PDA's ATA but `transfer/approve/transferFrom` cached
    /// PAYER_PDA's ATA in `_accounts`. The unification collapses the
    /// two roles onto a single PDA: it signs CPIs, owns ATAs, and pays
    /// rent. Self-bootstrap on first wrapper-mediated mutation means
    /// bridged-in / wrap-funded users + DEX router contracts don't have
    /// to call `factory.create_user` explicitly.
    function ensure_user(address user) public returns (bytes32) {
        bytes32 existing_user = users[user];
        if (existing_user == bytes32(0)) {
            bytes32 new_user = RomeEVMAccount.get_payer(user);
            users[user] = new_user;
            RomeEVMAccount.create_payer(user, CREATE_PAYER_LAMPORTS);
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

    /// @notice Public reader for the SPL token account owned by this EVM user.
    /// @dev Returns the canonical user-PDA ATA derived from the unified PDA
    ///      (post-0acabea). Equivalent to `UserPda.ata(user, mint_id)`. The
    ///      legacy `_accounts` cache is retained for write-through (callers
    ///      that previously relied on a non-zero cache value still see one
    ///      after any wrapper-mediated mutation). New callers should treat
    ///      this as the canonical lookup.
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
        
        // Only the unified user PDA needs to sign — auto-detected from metas.
        // No salt-derived signer involved → use `invoke`, not `invoke_signed`.
        (bool success, bytes memory result) = address(cpi_program).delegatecall(
            abi.encodeWithSignature(
                "invoke(bytes32,(bytes32,bool,bool)[],bytes)",
                program_id, accounts, data
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
        // Canonical user-PDA ATA derivation (post-0acabea unified PDA).
        // Skip the ATA-create CPI when Solana already has the account
        // initialized — saves a CPI per transfer in flows where the
        // recipient's ATA was created earlier (Romeswap pair.burn, repeat
        // wrapper.transfer to the same recipient, etc.). Without this
        // shortcut every wrapper.transfer would always do 2 CPIs (ATA
        // create + transfer_checked) and pair.burn (which makes 2× wrapper.
        // transfer back to the LP holder) exceeds Rome's per-tx CPI budget.
        bytes32 ata = UserPda.ata(user, mint_id);
        (uint64 lamports, , , , , ) = ICrossProgramInvocation(cpi_program).account_info(ata);
        if (lamports != 0) {
            // Account already exists on Solana — no CPI needed.
            // Cache write-through is optional; legacy callers checking
            // `_accounts[user] != 0` still need a non-zero entry, so we
            // populate it for back-compat.
            _accounts[user] = ata;
            return ata;
        }

        // First-time recipient — call create_associated_token_account_idempotent
        // CPI. ensure_user populates the ERC20Users mapping AND funds the
        // unified user PDA at the rent-exempt floor (1M lamports).
        bytes32 payer = _users.ensure_user(msg.sender);
        return create_token_account(user, payer);
    }

    /**
     * Gets the canonical SPL associated token account for an EVM user.
     * @dev Post-0acabea unified-PDA derivation: returns `UserPda.ata(user, mint_id)`
     *      = `getATA(AUTHORITY_PDA(user), mint)`. This is the SAME ATA where
     *      bridge-in deposits land and where balanceOf reads. No revert when
     *      the ATA hasn't been on-chain-initialized yet — callers that need
     *      it created must call `ensure_token_account(user)` (idempotent on
     *      repeat calls). The legacy `_accounts` cache is no longer the
     *      source of truth; this function ignores it to fix the split-brain
     *      where balanceOf read AUTHORITY_PDA's ATA but transfer/approve/
     *      transferFrom read the cached PAYER_PDA's ATA, breaking router-
     *      mediated flows like Romeswap addLiquidity.
     */
    function get_token_account(address user) public view returns (bytes32) {
        return UserPda.ata(user, mint_id);
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
        bytes32 ata = ICrossProgramInvocation(cpi_program).derive_user_ata(account, mint_id);
        // SPL TokenAccount.amount is a u64 LE at offset 64.
        return uint256(ICrossProgramInvocation(cpi_program).account_u64_at(ata, 64));
    }

    function transfer(address to, uint256 value) public virtual returns (bool) {
        return _transfer(_users.ensure_user(msg.sender), msg.sender, to, value);
    }

    /**
     * Internal transfer function that performs a token transfer by invoking the SPL Token program's TransferChecked instruction via CPI.
     * @param user The User struct containing payer and seeds for the signer
     * @param from EVM address of the sender
     * @param to EVM address of the recipient
     * @param value amount of tokens to transfer (in the smallest unit, e.g. if decimals is 6, then value should be in micro-units)
     * 
     * @return success Returns true if the transfer was successful
     */
    function _transfer(
        bytes32 user,
        address from,
        address to,
        uint256 value
    ) internal returns (bool) {
        require(value <= type(uint64).max, "Transfer amount exceeds uint64");
        // Auto-create the recipient's PDA-owned ATA on first transfer.
        // Without this, sending an SPL_ERC20 wrapper to a fresh address
        // reverts with "Token account does not exist" because the
        // recipient never went through the wrapper's
        // `ensure_token_account` flow (no inbound bridge, no prior
        // receive). MetaMask's `eth_call` simulation surfaces the
        // revert as a greyed-out Send button, leaving users unable to
        // transfer their tokens. Idempotent: returns the cached /
        // existing ATA when it's already there, costs ~0.002 SOL rent
        // (paid by the sender / spender) when it's not. Same UX model
        // as Phantom and every other Solana wallet.
        bytes32 to_account = ensure_token_account(to);
        (bytes32 program_id, ICrossProgramInvocation.AccountMeta[] memory accounts, bytes memory data) =
        SplTokenLib.transfer_checked(
            SplTokenLib.SPL_TOKEN_PROGRAM,
            get_token_account(from),
            mint_id,
            to_account,
            user,
            new bytes32[](0),
            uint64(value),
            decimals
        );

        // Only the unified user PDA signs (= `user` arg above) — auto-detected
        // from metas. No salt-derived signer → use `invoke`.
        (bool success, bytes memory result) = address(cpi_program).delegatecall(
            abi.encodeWithSignature(
                "invoke(bytes32,(bytes32,bool,bool)[],bytes)",
                program_id, accounts, data
            )
        );

        require (success, string(Convert.revert_msg(result)));
        emit Transfer(from, to, value);
        return true;
    }

    function allowance(address owner, address spender) public view virtual returns (uint256) {
        bytes32 spenderUser = _users.get_user(spender);
        (bytes32 delegate, uint64 delegated_amount) =
                            SplTokenLib.load_token_account_delegate(get_token_account(owner), cpi_program);
        if (delegate != spenderUser) {
            return uint256(0);
        }

        return uint256(delegated_amount);
    }

    function approve(address spender, uint256 value) public virtual returns (bool) {
        // ensure_user on both sides — both owner AND spender need
        // ERC20Users entries (the SPL approve sets the spender's unified
        // PDA as delegate, and transferFrom signs as that PDA). Without
        // auto-register, contract spenders (DEX routers, paymasters)
        // can never be approved-to since they have no natural way to
        // call factory.create_user themselves.
        bytes32 ownerUser = _users.ensure_user(msg.sender);
        bytes32 spenderUser = _users.ensure_user(spender);

        (bytes32 program_id, ICrossProgramInvocation.AccountMeta[] memory accounts, bytes memory data) = 
        SplTokenLib.approve(
            SplTokenLib.SPL_TOKEN_PROGRAM,
            get_token_account(msg.sender),
            spenderUser,
            ownerUser,
            new bytes32[](0),
            uint64(value)
        );

        // Only the owner's unified user PDA signs — auto-detected from metas.
        // No salt-derived signer → use `invoke`.
        (bool success, bytes memory result) = address(cpi_program).delegatecall(
            abi.encodeWithSignature(
                "invoke(bytes32,(bytes32,bool,bool)[],bytes)",
                program_id, accounts, data
            )
        );

        require (success, string(Convert.revert_msg(result)));
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) public virtual returns (bool) {
        address spender = msg.sender;
        return _transfer(_users.ensure_user(spender), from, to, value);
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
    ///     idempotently if missing — the caller's unified user PDA pays
    ///     the ~0.002 SOL rent (matches Phantom's "send to fresh address"
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

        // Single unified user PDA per EVM address (post-0acabea):
        //   userPda = find_program_address([EXTERNAL_AUTHORITY, evmAddr])
        // Signs CPIs, owns ATAs (bridged-in and wrap-funded land here),
        // and pays rent for new accounts. Pre-existing wrappers may
        // expose a legacy `_users.get_user` mapping that historically
        // returned PAYER_PDA (a salted sub-PDA); under the unified
        // model, that mapping returns userPda — same value as
        // RomeEVMAccount.pda(msg.sender). bridgeOutToSolana takes the
        // direct path via RomeEVMAccount.pda to skip the mapping lookup.
        bytes32 authority_pda = RomeEVMAccount.pda(msg.sender);
        bytes32 from_ata = UserPda.ataForKey(authority_pda, mint_id);

        // Recipient ATA — derive only. Caller must pre-create on Solana
        // if it doesn't exist (use ensureRecipientAta below as a separate
        // tx). Adding the in-tx ATA-create CPI failed on rome-evm's
        // CPI emulator (the two-CPI sequence reverts at sim time even
        // though the contract logic is correct). Single CPI (transfer
        // only) works reliably on chain.
        bytes32 to_ata = UserPda.ataForKey(solana_recipient, mint_id);

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

        // The unified user PDA signs as `authority_pda` (owner of from_ata) —
        // auto-detected from metas. No salt-derived signer → use `invoke`.
        (bool success, bytes memory result) = address(cpi_program).delegatecall(
            abi.encodeWithSignature(
                "invoke(bytes32,(bytes32,bool,bool)[],bytes)",
                program_id, accounts, data
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
    /// caller's pre-funded unified user PDA (no Solana wallet needed).
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

        // Unified user PDA — funds the ATA-create rent and serves as
        // the rent-payer in the AssociatedToken `Create` instruction.
        bytes32 user_pda = _users.ensure_user(msg.sender);

        (
            bytes32 program_id,
            ICrossProgramInvocation.AccountMeta[] memory accounts,
            bytes memory data,
            bytes32 to_ata
        ) = AssociatedSplToken.create_associated_token_account_idempotent(
            user_pda,
            solana_recipient,
            mint_id,
            system_program_id,
            SplTokenLib.SPL_TOKEN_PROGRAM,
            associated_token_program_id
        );

        // Caller's unified user PDA pays rent (= `user_pda` arg above) —
        // auto-detected from metas. No salt-derived signer → use `invoke`.
        (bool success, bytes memory result) = address(cpi_program).delegatecall(
            abi.encodeWithSignature(
                "invoke(bytes32,(bytes32,bool,bool)[],bytes)",
                program_id, accounts, data
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
        // Mint to a fresh address: ensure the recipient's PDA-owned
        // ATA exists before the SPL mint_to_checked CPI. Same
        // idempotent pattern as `_transfer` above — no-op when the
        // ATA already exists.
        bytes32 to_account = ensure_token_account(to);
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

        // mint_to_checked signs as the mint authority's unified user PDA —
        // auto-detected from metas. No salt-derived signer → use `invoke`.
        (bool success, bytes memory result) = address(cpi_program).delegatecall(
            abi.encodeWithSignature(
                "invoke(bytes32,(bytes32,bool,bool)[],bytes)",
                program_id, accounts, data
            )
        );

        require (success, string(Convert.revert_msg(result)));
        emit Transfer(address(0), to, value);
        return true;
    }
}
