// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SplTokenLib} from "../spl_token/spl_token.sol";
import {AssociatedSplToken} from "../spl_token/associated_spl_token.sol";
import {ISystemProgram, ICrossProgramInvocation, CpiProgram, HelperProgram} from "../interface.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";
import {UserPda} from "../cpi/UserPda.sol";
import {AccountReader} from "../cpi/AccountReader.sol";
import {Convert} from "../convert.sol";

contract ERC20Users {
    mapping (address => bytes32) private users;

    /// @notice Idempotent registration of the user's unified PDA in the
    ///         wrapper's `users` mapping.
    /// @dev    Registers the caller-derived `external_auth(user)` PDA as
    ///         the wrapper's record of `user`. The mapping is consulted
    ///         by `approve` / `transferFrom` when treating the spender's
    ///         PDA as an SPL Token delegate. Repeat calls are no-ops.
    ///
    ///         **No PDA funding here.** PDA activation (turning the
    ///         seed-derived address into a real Solana account with SOL
    ///         lamports for rent-payer roles) is handled exclusively by
    ///         the `SimpleActivator.activate{value: activationCost}()`
    ///         one-tx flow, which creates + funds the user's PDA AND
    ///         creates the wUSDC + wSOL ATAs AND registers in the
    ///         ERC20Users mapping in a single user-paid Rome tx. The
    ///         earlier operator-subsidized
    ///         `RomeEVMAccount.create_payer(user, 50_000_000)` call has
    ///         been removed — Sybil-vulnerable and antithetical to the
    ///         "user pays for activation" design.
    ///
    ///         Most wrapper operations (transfer / approve / transferFrom
    ///         / balanceOf / swap / liquidity) work without the PDA
    ///         being activated — SPL Token signatures don't require the
    ///         signer to hold lamports. Only operations that designate
    ///         the user PDA as **rent payer** for new account creation
    ///         (CCTP outbound's `messageSentEventData`, Wormhole
    ///         outbound's message account, etc.) need a funded PDA. The
    ///         UI surfaces an Activate button before those flows.
    function ensure_user(address user) public returns (bytes32) {
        bytes32 existing_user = users[user];
        if (existing_user == bytes32(0)) {
            bytes32 new_user = RomeEVMAccount.get_payer(user);
            users[user] = new_user;
            return new_user;
        } else {
            return existing_user;
        }
    }

    /// @notice Returns the previously-registered unified PDA for `user`,
    ///         reverting if `user` has not yet been registered via
    ///         `ensure_user`. Used by meteora pool + factory to gate
    ///         operations on caller registration. Kept for cross-contract
    ///         back-compat; new code should prefer `HelperProgram.pda`
    ///         (direct derivation, no revert).
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
        //
        // Two precompile shortcuts (rome-evm-private PR #318 + #319):
        //  - `derive_user_ata` collapses 2× findPda (EXTERNAL_AUTH → unified
        //    PDA → ATA-of-PDA) into one syscall.
        //  - `account_lamports` fetches lamports only — no data buffer pull,
        //    no Borsh decoding. The fast-path here only needs lamports != 0
        //    to confirm the account is initialized.
        bytes32 ata = HelperProgram.ata(user, mint_id);
        uint64 lamports = AccountReader.lamportsOf(ata);
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
        return HelperProgram.ata(user, mint_id);
    }

    function name() public view virtual returns (string memory) {
        return _name;
    }

    function symbol() public view virtual returns (string memory) {
        return _symbol;
    }

    function totalSupply() public view virtual returns (uint256) {
        // SPL Mint layout: 0..3 mint_authority COption tag, 4..35 pubkey,
        // 36..43 supply (u64 LE) — what we want, 44 decimals, 45 init,
        // 46..81 freeze_authority COption. `account_u64_at` reads exactly
        // the 8-byte supply field directly — no full mint Borsh decode,
        // no 5-tuple ABI roundtrip.
        //
        // ERC-20 spec invariant (FB-2c): never revert on a view method.
        // When the mint account is uninitialized — wrapper deployed against
        // a stale or never-funded mint address — `account_u64_at(mint, 36)`
        // would revert "account_u64_at: offset 36 + 8 out of 0 bytes",
        // breaking every consumer that probes totalSupply on chain
        // bring-up. `account_lamports` is the cheap existence probe (no
        // data buffer pull) used symmetrically by `balanceOf` and
        // `allowance` below.
        if (AccountReader.lamportsOf(mint_id) == 0) {
            return 0;
        }
        return uint256(AccountReader.readU64At(mint_id, 36));
    }

    function balanceOf(address account) public view virtual returns (uint256) {
        // Single CrossStateEthCall via HelperProgram.user_balance. Reads
        // SPL TokenAccount.amount (u64 LE at offset 64) on the user's
        // PDA-owned ATA. Returns 0 if the ATA doesn't exist (fresh-chain
        // probe — same canonical AUTHORITY_PDA-ATA semantic as the legacy
        // 3-dispatch composition: HelperProgram.ata + AccountReader.lamportsOf
        // + AccountReader.readU64At). Projected saving: ~37K Solana CU
        // per call (3 dispatches → 1).
        return uint256(HelperProgram.user_balance(account, mint_id));
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
        // Suppress unused-parameter warning. `user` was the SPL Token
        // authority passed explicitly in the legacy path. Post-migration
        // the precompile derives `external_auth(msg.sender)` itself.
        // Callers still compute `user` for the `ensure_user` mapping-side-effect.
        user;
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

        // Migration 2026-05-14 (spec: rome-specs/active/technical/
        // 2026-05-14-rome-primitive-cu-baseline.md): switched from the
        // legacy `SplTokenLib.transfer_checked + CpiProgram.invoke`
        // pattern (~554K CU per call) to `HelperProgram.transfer_spl`
        // overloads (~160K–182K CU per call). Two paths — one for the
        // sender path where caller IS the owner of the source ATA, one
        // for the delegate path where caller is the SPL delegate set
        // by a prior `approve()`.
        bool success;
        bytes memory result;
        if (from == msg.sender) {
            // SENDER PATH (`transfer(to, value)`): caller owns the
            // source ATA. The 3-arg overload `transfer_spl(address,
            // uint64, bytes32)` derives `src_ata = HelperProgram.ata(
            // msg.sender, mint)` server-side — matches the canonical
            // owner ATA. Signs as `external_auth(msg.sender)` which IS
            // the source ATA's owner. Measured saving: −394K CU
            // (−71%) vs legacy.
            (success, result) = address(HelperProgram).delegatecall(
                abi.encodeWithSignature(
                    "transfer_spl(address,uint64,bytes32)",
                    to, uint64(value), mint_id
                )
            );
        } else {
            // DELEGATE PATH (`transferFrom(from, to, v)`): caller is
            // the SPL delegate set by a prior `approve()` (which now
            // writes external_auth(spender) as delegate via the new
            // approve_spl selector). Use the addr-keyed 4-arg overload
            // — Rust internally derives src_ata = ata(external_auth(from),
            // mint) and dst_ata = ata(external_auth(to), mint). Signs as
            // external_auth(msg.sender) = the delegate PDA. SPL Token
            // accepts delegate-as-authority when delegated_amount ≥ value.
            // Replaces the prior bytes32-ATA variant (0x766b362a) —
            // selectors are distinct; this is 0xe479df56. Eliminates
            // Solidity-side ATA derivation via get_token_account.
            // Reference `to_account` so the compiler doesn't warn —
            // ensure_token_account(to) above still creates the ATA when
            // missing; the precompile re-derives but won't create.
            to_account;
            (success, result) = address(HelperProgram).delegatecall(
                abi.encodeWithSignature(
                    "transfer_spl(address,address,uint64,bytes32)",
                    from, to, uint64(value), mint_id
                )
            );
        }

        require (success, string(Convert.revert_msg(result)));
        emit Transfer(from, to, value);
        return true;
    }

    function allowance(address owner, address spender) public view virtual returns (uint256) {
        // Single CrossStateEthCall via HelperProgram.allowance_of. Reads
        // owner-ATA's delegated_amount IFF on-chain delegate ==
        // external_auth(spender) (HARD REQ enforced inside Rust — see
        // 2026-05-16 spec). Returns 0 otherwise — covers fresh user (no
        // ATA), unapproved spender (no delegate or wrong delegate), and
        // expired allowance. Collapses 5 v1 dispatches into 1. Projected
        // saving: ~37K Solana CU per call.
        uint64 delegated = HelperProgram.allowance_of(owner, spender, mint_id);
        // Saturation sentinel: u64::MAX storage → uint256::MAX readback.
        // Pairs with the saturation cap inside approve() so wallets that
        // probe `if allowance == MaxUint256` (infinite-approval sentinel)
        // keep working.
        return delegated == type(uint64).max ? type(uint256).max : uint256(delegated);
    }

    function approve(address spender, uint256 value) public virtual returns (bool) {
        // Register owner in ERC20Users mapping (mapping-side-effect for
        // any consumers still reading _users). Spender registration is no
        // longer required — allowance_of uses external_auth(spender)
        // directly and the new approve_spl selector signs as the caller's
        // PDA without needing the spender's mapping entry.
        _users.ensure_user(msg.sender);

        // SPL Token stores delegated_amount as u64 on-chain; we cannot
        // expand the storage layer. Saturate when the caller's value
        // exceeds type(uint64).max. The companion allowance() reader
        // surfaces uint64.max storage as type(uint256).max so the
        // standard wallet pattern `if allowance == MaxUint256` keeps
        // working as an "infinite approval" sentinel.
        uint64 storedAmount = value > type(uint64).max
            ? type(uint64).max
            : uint64(value);

        // Migration to HelperProgram.approve_spl — moves SPL Approve ix
        // marshaling from Solidity (SplTokenLib.approve + raw invoke,
        // ~150-200K CU of EVM bytecode) into Rust (~5-10K CU). Signs
        // as external_auth(msg.sender) which IS the owner of the source
        // ATA. SPL Token runtime stores external_auth(spender) as the
        // delegate; allowance_of compares against the same derivation.
        (bool success, bytes memory result) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "approve_spl(address,uint64,bytes32)",
                spender, storedAmount, mint_id
            )
        );
        require(success, string(Convert.revert_msg(result)));

        // Emit the effective approval — when storage saturates at u64::MAX
        // surface as MaxUint256 so the on-chain event matches the readback
        // from allowance().
        uint256 emittedValue = storedAmount == type(uint64).max
            ? type(uint256).max
            : uint256(storedAmount);
        emit Approval(msg.sender, spender, emittedValue);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) public virtual returns (bool) {
        address spender = msg.sender;
        return _transfer(_users.ensure_user(spender), from, to, value);
    }

    /// @notice Move this wrapper's underlying SPL out of the caller's
    /// PDA-owned ATA to an arbitrary Solana wallet. Generic Rome →
    /// Solana exit door for ANY wrapper deployed by the factory —
    /// works the same for wUSDC, wETH, wSOL, wJUP, wBONK, custom long-tail
    /// tokens. No Wormhole, no CCTP, no per-asset bridge contract.
    ///
    /// Two CPIs per call:
    ///   1. `AssociatedToken.CreateIdempotent(recipient ATA)` — funded
    ///      by `msg.sender`'s unified user PDA. No-ops on the Solana
    ///      side when the ATA already exists. Cost: ~0.002 SOL rent on
    ///      first call per (recipient, mint) pair; zero on repeat. The
    ///      sender's PDA must hold ≥ ATA_RENT lamports — provisioned
    ///      by `SimpleActivator.activate()` and refillable via
    ///      `SimpleActivator.topUpUserPda` once the
    ///      `FRESH_TRANSFER_RESERVE` is drained.
    ///   2. `HelperProgram.transfer_spl(to_ata, value, mint)` — actual
    ///      SPL move from `from_ata` (caller's PDA-owned ATA) →
    ///      `to_ata` (recipient's ATA). Signed as
    ///      `external_auth(msg.sender)`.
    ///
    /// Asymmetry vs. the EVM-side `transfer(address, uint256)`:
    ///   - `to` is a raw Solana wallet pubkey, NOT derived from an EVM
    ///     address. The recipient does not need a Rome account.
    ///   - The recipient's ATA is created idempotently if missing —
    ///     matches Phantom's "send to fresh address" UX.
    ///
    /// Behavior:
    ///   - The wrapper's `balanceOf(msg.sender)` decreases by `value`.
    ///   - The Solana recipient's wallet shows `value` of the underlying
    ///     SPL after this tx confirms.
    ///   - For wSOL specifically (canonical mint
    ///     So11111111111111111111111111111111111111112), the recipient
    ///     can `close_account` on their wSOL ATA in a follow-up Solana
    ///     tx to convert the SPL back to native lamports.
    ///
    /// Why the inline ATA-create works now (it didn't pre-2026-05-15):
    ///   The previous attempt at a two-CPI atomic `bridgeOutToSolana`
    ///   failed in the rome-evm CPI emulator (the create + transfer
    ///   sequence reverted at sim time even though the on-chain logic
    ///   was sound). The recent rome-evm-private clean-up of the CPI
    ///   precompile + the AssociatedSplToken idempotent path lets the
    ///   two CPIs sit in one atomic Rome DoTx without busting the
    ///   1.4M CU budget; the user PDA's pre-funded reserve covers the
    ///   ATA-create rent. Measured 1-tx atomic CU on Hadrian (probe
    ///   2026-05-15): mean ~234K for the analogous 5-CPI activator
    ///   tx; 2-CPI bridgeOut is comfortably under that.
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

        // Source ATA = caller's unified-user-PDA's ATA for this mint.
        // Single CPI via `HelperProgram.ata(user, mint)` — composes the
        // two `find_program_address` syscalls (EXTERNAL_AUTHORITY → user
        // PDA → ATA-of-PDA) into one dispatch. Measured −152K Solana CU
        // vs the prior two-hop path (Marcus 121301, 2026-05-11; Hadrian
        // confirms −170K, 2026-05-14).
        bytes32 from_ata = HelperProgram.ata(msg.sender, mint_id);

        // Recipient ATA pubkey — same canonical ATA derivation but for
        // the raw Solana recipient pubkey (not an EVM address), so the
        // `HelperProgram.ata(address, bytes32)` overload doesn't apply
        // — `UserPda.ataForKey` keeps the deterministic two-step Solana
        // find_program_address derivation for an arbitrary pubkey.
        bytes32 to_ata = UserPda.ataForKey(solana_recipient, mint_id);

        // CPI 1 — `AssociatedToken.CreateIdempotent` for the recipient
        // ATA, funded by `msg.sender`'s unified user PDA. Idempotent on
        // the Solana side: no-op when the account already exists,
        // create + rent when not. Removes the need for callers to run
        // a separate `ensureRecipientAta` preflight (which is still
        // exposed below as a public helper for callers that want it).
        //
        // Funder: `_users.ensure_user(msg.sender)` — the caller's PDA
        // pre-funded by `SimpleActivator.activate()` with at least
        // 2× ATA_RENT + reserve. If the PDA's reserve is drained, this
        // CPI reverts at the System Program's CreateAccount step (not
        // enough lamports to fund the new account); UI surfaces the
        // revert as "top up your PDA reserve".
        bytes32 funder_pda = _users.ensure_user(msg.sender);
        (
            bytes32 ata_program_id,
            ICrossProgramInvocation.AccountMeta[] memory ata_accounts,
            bytes memory ata_data,
            /* derived ata — same as to_ata */
        ) = AssociatedSplToken.create_associated_token_account_idempotent(
            funder_pda,
            solana_recipient,
            mint_id,
            system_program_id,
            SplTokenLib.SPL_TOKEN_PROGRAM,
            associated_token_program_id
        );
        (bool ataOk, bytes memory ataResult) = address(cpi_program).delegatecall(
            abi.encodeWithSignature(
                "invoke(bytes32,(bytes32,bool,bool)[],bytes)",
                ata_program_id, ata_accounts, ata_data
            )
        );
        require(ataOk, string(Convert.revert_msg(ataResult)));

        // CPI 2 — SPL `transfer_checked` from caller's PDA-owned ATA
        // to the recipient's ATA. The `bytes32 to_ata` overload is
        // required because the recipient is a raw Solana pubkey (not
        // an EVM address). Signs as `external_auth(msg.sender)`,
        // matching `from_ata`'s owner.
        (bool xferOk, bytes memory xferResult) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "transfer_spl(bytes32,uint64,bytes32)",
                to_ata, uint64(value), mint_id
            )
        );
        require(xferOk, string(Convert.revert_msg(xferResult)));

        // Reference `from_ata` so the compiler doesn't warn — kept as a
        // doc-only variable since the precompile re-derives source ATA
        // server-side from the caller's external_auth PDA.
        from_ata;

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

    /// @notice Standalone helper to create a recipient's ATA on Solana
    /// for this wrapper's mint, paid for from the caller's pre-funded
    /// unified user PDA.
    ///
    /// **Status post-2026-05-15 collapse:** `bridgeOutToSolana` now
    /// inlines this same CreateIdempotent CPI internally, so callers
    /// no longer NEED to preflight. This function is kept as a public
    /// idempotent helper for callers (off-chain scripts, custom flows)
    /// that want to pre-warm an ATA without spending tokens. The
    /// rome-ui hook `useOutboundSplBridge` skips this call in the new
    /// path; the legacy probe-then-call dance is no longer required.
    ///
    /// Idempotent: returns the same ATA address whether it pre-existed
    /// or was created.
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

        // Register caller (mint authority) in ERC20Users mapping for any
        // consumers still reading _users. The new selector signs as
        // external_auth(msg.sender) — SPL Token runtime enforces that
        // this PDA is the on-chain mint authority.
        _users.ensure_user(msg.sender);

        // Mint to a fresh address: ensure the recipient's PDA-owned
        // ATA exists before the SPL mint_to_checked CPI. New mint_spl
        // selector assumes the ATA exists — same as legacy. Idempotent
        // on repeat (lamports != 0 fast-path).
        ensure_token_account(to);

        // Migration to HelperProgram.mint_spl — moves SPL MintTo ix
        // marshaling from Solidity (SplTokenLib.mint_to_checked + raw
        // invoke) into Rust. Signs as external_auth(msg.sender); SPL
        // runtime enforces caller-PDA == on-chain mint authority.
        // Projected saving: ~150-200K CU per call (matches transfer_spl
        // migration which measured -372K CU on Hadrian).
        (bool success, bytes memory result) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "mint_spl(address,uint64,bytes32)",
                to, uint64(value), mint_id
            )
        );
        require(success, string(Convert.revert_msg(result)));

        emit Transfer(address(0), to, value);
        return true;
    }
}
