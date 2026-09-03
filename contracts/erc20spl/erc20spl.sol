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

/// A mint whose transfer hook is armed cannot be wrapped: the hook requires
/// extra accounts that no transfer path in this wrapper supplies. Unarmed hooks
/// are inert and are accepted.
error ArmedTransferHookUnsupported(bytes32 mint, bytes32 hookProgram);

/// @dev Shared implementation for the fixed-account and hook-aware direct-CPI
/// wrappers. Concrete wrappers choose their admission policy in the base
/// constructor; callers must never deploy this abstract implementation.
abstract contract SPL_ERC20Base is IERC20, IERC20Metadata {
    // SystemProgram
    bytes32 public constant system_program_id = 0x0000000000000000000000000000000000000000000000000000000000000000;
    // ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
    bytes32 public constant associated_token_program_id = 0x8c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f859;

    address public immutable cpi_program;
    bytes32 public immutable mint_id;
    uint8 public immutable decimals;

    string private _name;
    string private _symbol;
    ERC20Users internal _users;

    // Post-#511 (default-deny at the non-EVM dispatch boundary refuses a
    // DELEGATECALL/CALLCODE into a mutating precompile selector that isn't
    // exempt): this wrapper can no longer move a user's SPL by borrowing
    // the user's own authority via delegatecall. Every EOA-side movement
    // below is a direct CALL, which signs as external_auth(address(this))
    // — so the wrapper must be the user's SPL delegate, set once by the
    // user's own EOA sending `approve_spl(wrapper, u64.max, mint)` to
    // 0xff..09. `allowance`/`approve` below are the EVM-side allowance
    // this contract tracks itself; they no longer touch that SPL-level
    // grant at all.
    mapping(address => mapping(address => uint256)) private _allowances;

    // Contract-holder escrow (scope §6.2): a deployed pool/pool-like
    // contract can never call `approve`, so its SPL lives in this
    // wrapper's own ATA (owned by external_auth(address(this))) and its
    // balance is tracked here instead of read off-chain. balanceOf
    // dispatches on `account.code.length` to decide which of the two to
    // read. CREATE2-counterfactual note: an address that has no code yet
    // is treated as an EOA — SPL sent to it lands in
    // ata(external_auth(addr)), same as any other EOA. If that address is
    // later deployed to as a contract, those pre-deploy funds are NOT
    // migrated into `_escrow` automatically (this contract has no way to
    // observe a future deploy) — they join the same drain/rescue set as
    // pre-#511 contract-held balances (§0.2's corollary, §5 PR 0). A
    // counterfactual address that expects to receive funds after code
    // lands should be funded post-deploy, not pre-deploy.
    mapping(address => uint256) private _escrow;

    error ERC20InvalidApprover(address approver);
    error ERC20InvalidSpender(address spender);
    error ERC20InsufficientAllowance(address spender, uint256 currentAllowance, uint256 requiredAllowance);

    constructor(
        bytes32 _mint_id, 
        address _cpi_program, 
        string memory name_, 
        string memory symbol_,
        ERC20Users users_,
        bool supports_armed_transfer_hook
    ) {
        // decimals is the only mint fact this wrapper needs, and mint_info
        // supplies it without parsing mint bytes in Solidity. It also tells us
        // whether a transfer hook is ARMED, which this wrapper cannot honour —
        // an armed hook needs extra accounts no transfer path here supplies, so
        // the wrapper refuses to exist rather than reverting on every transfer.
        // A present-but-unarmed hook is inert and must pass.
        (, uint8 mint_decimals, bytes32 hook_program, ,) = HelperProgram.mint_info(_mint_id);
        if (hook_program != bytes32(0) && !supports_armed_transfer_hook) {
            revert ArmedTransferHookUnsupported(_mint_id, hook_program);
        }

        cpi_program = _cpi_program;
        mint_id = _mint_id;
        decimals = mint_decimals;
        _name = name_;
        _symbol = symbol_;
        _users = users_;
    }

    /**
     * Helper function to create an associated token account for a user if it doesn't exist, and return the associated token account address.
     * @param user EVM address of the user for whom to create the associated token account
     * @return associated_account_address The address of the associated token account created or existing for the user
     */
    function create_token_account(address user, bytes32 /* payer (deprecated post-#364) */) public returns(bytes32) {
        // Register the user in the ERC20Users mapping (idempotent EVM SSTORE,
        // no Solana CPI).
        _users.ensure_user(user);

        // Idempotent ATA-create via `HelperProgram.create_ata(address, bytes32)`
        // (selector `0x3de2251a`). The precompile derives the ATA owner as
        // external_auth(user) internally and dispatches the AssociatedToken
        // CreateIdempotent CPI in one Rust selector call. Replaces the prior
        // `AssociatedSplToken + CpiProgram.invoke` marshaling — saves ~30-50K
        // EVM CU per call.
        //
        // **Rent-payer change post-the Rome EVM program #364:** the `payer` arg
        // is now ignored (kept in the signature for back-compat — 5 off-chain
        // test/deploy scripts pass it). The operator pays rent and is
        // reimbursed via Rome's standard gas accounting. Callers that
        // previously sized their PDA reserve to cover ATA rent no longer
        // need that buffer for this path; gas balance suffices.
        (bool success, bytes memory result) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "create_ata(address,bytes32)",
                user, mint_id
            )
        );
        require(success, string(Convert.revert_msg(result)));

        return HelperProgram.ata(user, mint_id);
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
        // Two precompile shortcuts (a Rome EVM program upgrade + #319):
        //  - `derive_user_ata` collapses 2× findPda (EXTERNAL_AUTH → unified
        //    PDA → ATA-of-PDA) into one syscall.
        //  - `account_lamports` fetches lamports only — no data buffer pull,
        //    no Borsh decoding. The fast-path here only needs lamports != 0
        //    to confirm the account is initialized.
        bytes32 ata = HelperProgram.ata(user, mint_id);
        uint64 lamports = AccountReader.lamportsOf(ata);
        if (lamports != 0) {
            // Account already exists on Solana — no CPI needed.
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
     *      repeat calls).
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
        // Contract-holder escrow (§6.2): a contract's SPL sits in this
        // wrapper's own ATA, not `ata(external_auth(account))` — its
        // balance is the ledger, not an on-chain read.
        if (account.code.length > 0) {
            return _escrow[account];
        }
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
    ) internal virtual returns (bool) {
        require(value <= type(uint64).max, "Transfer amount exceeds uint64");
        // Suppress unused-parameter warning. `user` was the SPL Token
        // authority passed explicitly in the legacy path. Post-migration
        // the precompile derives the signer from context.caller itself.
        // Callers still compute `user` for the `ensure_user` mapping-side-effect.
        user;

        // Post-#511, routing is by whether an endpoint HOLDS SPL under a
        // PDA it can sign for (an EOA, via the wrapper acting as its
        // delegate) or under this wrapper's own escrow ATA (a contract,
        // which can never call `approve`) — not by who the caller is.
        // `transfer` and `transferFrom` both land here identically.
        bool fromIsContract = from.code.length > 0;
        bool toIsContract = to.code.length > 0;

        // contract -> contract: the SPL never leaves this wrapper's own
        // ATA — a pure EVM ledger move, no CPI, no transfer-fee to net.
        if (fromIsContract && toIsContract) {
            uint256 fromBal = _escrow[from];
            require(fromBal >= value, "insufficient escrow balance");
            _escrow[from] = fromBal - value;
            _escrow[to] += value;
            emit Transfer(from, to, value);
            return true;
        }

        if (fromIsContract) {
            require(_escrow[from] >= value, "insufficient escrow balance");
        }

        // A transfer-fee mint credits the destination less than was requested,
        // and the fee is capped by maximum_fee — which mint_info deliberately
        // does not carry, because computing the fee here would duplicate SPL's
        // arithmetic and be wrong at the cap. So the delta is measured, and the
        // extra reads are paid for only when a fee is actually armed: feeBps is
        // a predicate, not an operand. Read on this contract's own track.
        (, , , uint16 feeBps, ) = HelperProgram.mint_info(mint_id);
        bool fee_armed = feeBps > 0;
        // Measure the delivered amount off whichever ATA actually receives
        // the SPL on-chain: this wrapper's own escrow ATA when `to` is a
        // contract (its ledger entry isn't updated yet, so balanceOf(to)
        // would read stale state), `to`'s own PDA-owned ATA otherwise.
        uint256 before = fee_armed
            ? (toIsContract ? uint256(HelperProgram.user_balance(address(this), mint_id)) : balanceOf(to))
            : 0;

        if (toIsContract) {
            // Contract recipient: ensure THIS wrapper's own escrow ATA
            // exists (a contract can't call ensure_token_account for
            // itself in any meaningful sense — the ATA that matters here
            // is the wrapper's, not `to`'s).
            _ensureWrapperAta();
        } else {
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
            ensure_token_account(to);
        }

        bool success;
        bytes memory result;
        if (!fromIsContract) {
            // `from` is an EOA: its SPL sits in `ata(external_auth(from))`.
            // Post-#511 this wrapper can no longer sign as that PDA via
            // delegatecall — it must be `from`'s SPL delegate instead (a
            // one-time user-signed `approve_spl(wrapper, …)` to 0xff..09).
            // Direct CALL so the precompile signs as
            // external_auth(address(this)); the addr-keyed 4-arg overload
            // accepts delegate-as-authority when delegated_amount ≥ value.
            // `to` collapses to address(this) when the recipient is a
            // contract, landing the SPL in this wrapper's own escrow ATA
            // instead of a contract that could never approve it back out.
            address dest = toIsContract ? address(this) : to;
            (success, result) = address(HelperProgram).call(
                abi.encodeWithSignature(
                    "transfer_spl(address,address,uint64,bytes32)",
                    from, dest, uint64(value), mint_id
                )
            );
        } else {
            // `from` is a contract holder: its SPL already sits in this
            // wrapper's own ATA (credited on the way in, below). The
            // 3-arg overload derives src_ata = ata(external_auth(context.
            // caller), mint) — under direct CALL that's
            // ata(external_auth(address(this))), the wrapper's own ATA,
            // which the wrapper owns outright. No delegate needed.
            (success, result) = address(HelperProgram).call(
                abi.encodeWithSignature(
                    "transfer_spl(address,uint64,bytes32)",
                    to, uint64(value), mint_id
                )
            );
        }

        require (success, string(Convert.revert_msg(result)));

        // Self-transfer needs the other direction. Sending to yourself with an
        // armed fee debits `value` and credits `value - fee`, so the account nets
        // MINUS fee — `after - before` would underflow and revert, and ERC-20
        // self-transfer must not revert. Measuring the loss gives the delivered
        // amount in both directions.
        uint256 delivered = value;
        if (fee_armed) {
            uint256 now_ = toIsContract
                ? uint256(HelperProgram.user_balance(address(this), mint_id))
                : balanceOf(to);
            delivered = to == from ? value - (before - now_) : now_ - before;
        }

        // Ledger side-effects mirror what actually moved on-chain: `from`
        // loses exactly `value` (the SPL transfer-fee, if any, is taken
        // from the destination, not the source); `to` gains exactly what
        // was delivered — never the raw request, or the ledger sum would
        // exceed the wrapper's real on-chain escrow-ATA balance.
        if (fromIsContract) {
            _escrow[from] -= value;
        }
        if (toIsContract) {
            _escrow[to] += delivered;
        }

        emit Transfer(from, to, delivered);
        return true;
    }

    /// @dev Ensures this wrapper's own SPL ATA exists — the escrow account
    /// that holds every contract holder's balance (§6.2). Uses the exempt
    /// `create_ata(address,bytes32)` selector; the ATA owner it derives is
    /// `external_auth(address(this))`, i.e. the wrapper itself.
    function _ensureWrapperAta() internal returns (bytes32) {
        bytes32 wrapperAta = HelperProgram.ata(address(this), mint_id);
        if (AccountReader.lamportsOf(wrapperAta) != 0) {
            return wrapperAta;
        }
        (bool success, bytes memory result) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "create_ata(address,bytes32)",
                address(this), mint_id
            )
        );
        require(success, string(Convert.revert_msg(result)));
        return wrapperAta;
    }

    function allowance(address owner, address spender) public view virtual returns (uint256) {
        // Post-#511: `approve_spl` (the SPL-level delegate grant) can no
        // longer be written by this wrapper on the owner's behalf — a
        // direct CALL would sign as the wrapper, which isn't the ATA
        // owner, so SPL Token's Approve instruction would reject it
        // outright (Tier-1 row #3). ERC-20 allowance is now a plain EVM
        // mapping, entirely decoupled from the SPL-level grant. No u64
        // saturation sentinel: this is uint256 EVM storage, not u64 SPL
        // delegated_amount storage, so there's nothing to saturate
        // against — a wallet's `approve(spender, type(uint256).max)`
        // stores exactly that, no remapping needed either way.
        return _allowances[owner][spender];
    }

    /// @notice Whether `user` has sent the one-time SPL-level delegate
    /// grant (`approve_spl(wrapper, …, mint)` direct to 0xff..09) this
    /// wrapper now needs to move their SPL at all. A precompile read,
    /// unaffected by the #511 gate. Callers (rome-ui, off-chain scripts)
    /// use this to decide whether to prompt the user for the one-time
    /// grant before the first transfer.
    function isEnabled(address user) public view returns (bool) {
        return HelperProgram.allowance_of(user, address(this), mint_id) > 0;
    }

    function approve(address spender, uint256 value) public virtual returns (bool) {
        if (spender == address(0)) {
            revert ERC20InvalidSpender(address(0));
        }
        _allowances[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) public virtual returns (bool) {
        address spender = msg.sender;
        uint256 currentAllowance = _allowances[from][spender];
        if (currentAllowance != type(uint256).max) {
            if (currentAllowance < value) {
                revert ERC20InsufficientAllowance(spender, currentAllowance, value);
            }
            unchecked {
                _allowances[from][spender] = currentAllowance - value;
            }
        }
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
    ///   was sound). The recent the Rome EVM program clean-up of the CPI
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

        // Recipient ATA pubkey — same canonical ATA derivation but for
        // the raw Solana recipient pubkey (not an EVM address), so the
        // `HelperProgram.ata(address, bytes32)` overload doesn't apply
        // — `UserPda.ataForKey` derives it for an arbitrary pubkey, resolving
        // the token program from the mint so the address matches whatever
        // `create_ata_for_key` will actually create.
        bytes32 to_ata = UserPda.ataForKey(solana_recipient, mint_id);

        // CPI 1 — `AssociatedToken.CreateIdempotent` for the recipient
        // ATA via `HelperProgram.create_ata_for_key(wallet, mint)`
        // (selector `0xd258a69d`, shipped in a Rome EVM program upgrade).
        // The precompile accepts a raw Solana pubkey as the ATA owner
        // (the prior 3-arg / addr-keyed `create_ata` variants only
        // handle EVM-derived owners). Idempotent on the Solana side:
        // no-op when the account already exists, create + rent when
        // not. Removes the need for callers to run a separate
        // `ensureRecipientAta` preflight (still exposed below).
        //
        // **Rent payer change post-#364:** the operator pays rent (not
        // the caller's PDA). Reimbursed via Rome's standard gas
        // accounting (operator → user gas-token debit). UX: callers no
        // longer need a pre-funded PDA reserve for the ATA-create step
        // — gas balance alone suffices. The `_users.ensure_user` call
        // is preserved (mapping-only, EVM SSTORE) because subsequent
        // bridge-out flows (CCTP burnUSDC / Wormhole burnETH) still
        // rely on the user being registered + having a PDA-reserve
        // for the per-tx message account rent.
        _users.ensure_user(msg.sender);
        (bool ataOk, bytes memory ataResult) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "create_ata_for_key(bytes32,bytes32)",
                solana_recipient, mint_id
            )
        );
        require(ataOk, string(Convert.revert_msg(ataResult)));

        // CPI 2 — SPL `transfer_checked` from caller's PDA-owned ATA to
        // the recipient's ATA. Post-#511 (Tier-1 row #4): the wrapper can
        // no longer delegatecall the owner-path selector to borrow the
        // caller's authority — direct CALL the caller-supplied-src_ata
        // delegate overload instead, with `src_ata` explicit
        // (`ata(external_auth(msg.sender))`) since the recipient is a raw
        // Solana pubkey, not an EVM address the 3-arg overload could
        // derive the source from. Signs as external_auth(address(this));
        // the caller must already be the wrapper's delegate (same
        // one-time approve_spl requirement as `transfer`/`transferFrom`).
        bytes32 src_ata = HelperProgram.ata(msg.sender, mint_id);
        (bool xferOk, bytes memory xferResult) = address(HelperProgram).call(
            abi.encodeWithSignature(
                "transfer_spl(bytes32,bytes32,uint64,bytes32)",
                src_ata, to_ata, uint64(value), mint_id
            )
        );
        require(xferOk, string(Convert.revert_msg(xferResult)));

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
    /// the Rome app hook `the outbound-bridge flow` skips this call in the new
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

        // Preserved for ERC20Users registration side-effect (EVM-storage
        // SSTORE only, no Solana CPI). Other downstream wrapper flows
        // expect the caller to be registered.
        _users.ensure_user(msg.sender);

        // Derive the recipient ATA client-side — `create_ata_for_key` is an
        // Invoke and returns nothing, but the address is deterministic from
        // (wallet, mint, spl_program). The token program comes from the mint
        // rather than being assumed, since it is part of the seeds.
        bytes32 to_ata = UserPda.ataForKey(solana_recipient, mint_id);

        // Idempotent ATA-create via `HelperProgram.create_ata_for_key`
        // (selector `0xd258a69d`, shipped in a Rome EVM program upgrade).
        // Operator pays rent (no longer drawn from caller's PDA reserve);
        // reimbursed via Rome's standard gas accounting. Replaces the
        // prior `AssociatedSplToken + CpiProgram.invoke` marshaling —
        // saves ~50-80K EVM CU per call (Solana-side CPI identical to
        // the ATA Program instruction either way).
        (bool success, bytes memory result) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "create_ata_for_key(bytes32,bytes32)",
                solana_recipient, mint_id
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

    // mint_to DELETED (#511 change 5 / scope §6.1): a direct CALL would
    // sign as external_auth(address(this)), which is not the on-chain
    // mint authority (`ERC20SPLFactory` sets it to
    // `HelperProgram.pda(creator)` — erc20spl_factory.sol:216), and this
    // wrapper cannot become the authority without an operator-run SPL
    // `SetAuthority` per mint. Minting is a creator/operator act, not a
    // user act — the creator EOA sends `mint_spl(address,uint64,bytes32)`
    // directly to 0xff..09 instead. ABI break: `wrapper.mint_to(...)` no
    // longer exists; callers that relied on it (faucets, test/deploy
    // tooling) must call the precompile directly from the mint authority.
}

/// @title SPL_ERC20
/// @notice Fixed-account direct-CPI wrapper for legacy SPL and Token-2022
///         mints that do not have an armed Transfer Hook.
/// @dev Its constructor deliberately retains the armed-hook safety gate. The
///      hook-aware sibling is SPL_ERC20_Token2022Hooked.
contract SPL_ERC20 is SPL_ERC20Base {
    constructor(
        bytes32 _mint_id,
        address _cpi_program,
        string memory name_,
        string memory symbol_,
        ERC20Users users_
    ) SPL_ERC20Base(_mint_id, _cpi_program, name_, symbol_, users_, false) {}
}
