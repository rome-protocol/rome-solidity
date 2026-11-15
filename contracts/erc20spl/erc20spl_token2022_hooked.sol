// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SPL_ERC20Base} from "./erc20spl.sol";
import {
    ICrossProgramInvocation,
    ISystemProgram,
    SystemProgram,
    HelperProgram
} from "../interface.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";
import {SolanaConstants} from "../cpi/SolanaConstants.sol";
import {Token2022HookedTransfer} from "../spl_token/token2022_hooked_transfer.sol";

/// @title SPL_ERC20_Token2022Hooked
/// @notice Direct-CPI ERC-20 surface for a Token-2022 mint with an armed Transfer Hook.
/// @dev Transfers take the caller-resolved hook account tail, check its hook-program and validation-PDA trailer against the mint's live hook, and forward it; with no live hook the tail is dropped.
contract SPL_ERC20_Token2022Hooked is SPL_ERC20Base {
    bytes internal constant EXTRA_ACCOUNT_METAS_SEED = "extra-account-metas";

    bytes32 public immutable hook_program;
    bytes32 public immutable validation_account;
    /// The wrapper's own external_auth PDA, derived once at construction.
    bytes32 public immutable self_pda;

    error ArmedTransferHookRequired(bytes32 mint);
    error Token2022MintRequired(bytes32 mint, bytes32 tokenProgram);
    error HookAccountPlanRequired();

    constructor(
        bytes32 _mint_id,
        address _cpi_program,
        string memory name_,
        string memory symbol_
    ) SPL_ERC20Base(_mint_id, _cpi_program, name_, symbol_, true) {
        (bytes32 tokenProgram, , bytes32 hookProgram, ,) =
            HelperProgram.mint_info(_mint_id);
        if (tokenProgram != SolanaConstants.TOKEN_2022_PROGRAM) {
            revert Token2022MintRequired(_mint_id, tokenProgram);
        }
        if (hookProgram == bytes32(0)) {
            revert ArmedTransferHookRequired(_mint_id);
        }

        hook_program = hookProgram;
        validation_account = _validationAccount(_mint_id, hookProgram);
        self_pda = RomeEVMAccount.pda(address(this));
    }

    /// @notice Always the on-chain balance; this wrapper does not escrow.
    function balanceOf(address account) public view override returns (uint256) {
        return uint256(HelperProgram.user_balance(account, mint_id));
    }

    /// @dev Solidity requires the override; this wrapper does not escrow.
    function _ensureWrapperAta() internal virtual override returns (bytes32) {
        revert HookAccountPlanRequired();
    }

    /// @notice Standard ERC-20 transfer cannot carry a dynamic Solana account
    ///         plan. Call transferWithHookAccounts instead.
    function transfer(address, uint256) public pure override returns (bool) {
        revert HookAccountPlanRequired();
    }

    /// @notice Standard ERC-20 transferFrom cannot carry a dynamic Solana
    ///         account plan. Call transferFromWithHookAccounts instead.
    function transferFrom(address, address, uint256)
        public
        pure
        override
        returns (bool)
    {
        revert HookAccountPlanRequired();
    }

    function transferWithHookAccounts(
        address to,
        uint256 value,
        ICrossProgramInvocation.AccountMeta[] calldata hookMetas
    ) external returns (bool) {
        return _hookedTransfer(msg.sender, to, value, hookMetas);
    }

    function transferFromWithHookAccounts(
        address from,
        address to,
        uint256 value,
        ICrossProgramInvocation.AccountMeta[] calldata hookMetas
    ) external returns (bool) {
        // transferChecked's authority is fixed to the wrapper's own PDA
        // regardless of msg.sender, so the inherited EVM allowance is the
        // only per-spender gate.
        _spendAllowance(from, msg.sender, value);
        return _hookedTransfer(from, to, value, hookMetas);
    }

    function _validationAccount(bytes32 mint, bytes32 hookProgram) private view returns (bytes32 validation) {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](2);
        seeds[0] = ISystemProgram.Seed(EXTRA_ACCOUNT_METAS_SEED);
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(mint));
        (validation, ) = SystemProgram.find_program_address(hookProgram, seeds);
    }

    /// @dev Follows the live hook: none gives an empty tail (a plain TransferChecked), a rotated
    ///      hook is validated against its own validation account.
    function _validateCurrentPlan(
        ICrossProgramInvocation.AccountMeta[] calldata hookMetas
    ) internal view returns (uint16 feeBps, ICrossProgramInvocation.AccountMeta[] calldata tail) {
        (bytes32 tokenProgram, , bytes32 liveHook, uint16 currentFeeBps,) =
            HelperProgram.mint_info(mint_id);
        if (tokenProgram != SolanaConstants.TOKEN_2022_PROGRAM) {
            revert Token2022MintRequired(mint_id, tokenProgram);
        }
        if (liveHook == bytes32(0)) {
            return (currentFeeBps, hookMetas[:0]);
        }
        bytes32 validation = liveHook == hook_program
            ? validation_account
            : _validationAccount(mint_id, liveHook);
        Token2022HookedTransfer.validate(liveHook, validation, hookMetas);
        return (currentFeeBps, hookMetas);
    }

    function _hookedTransfer(
        address from,
        address to,
        uint256 value,
        ICrossProgramInvocation.AccountMeta[] calldata hookMetas
    ) internal returns (bool) {
        if (to == address(0)) revert ERC20InvalidReceiver(address(0));
        if (value == 0) {
            emit Transfer(from, to, 0);
            return true;
        }
        require(value <= type(uint64).max, "Transfer amount exceeds uint64");
        (uint16 feeBps, ICrossProgramInvocation.AccountMeta[] calldata tail) = _validateCurrentPlan(hookMetas);
        bool feeArmed = feeBps > 0;
        uint256 beforeBalance = feeArmed ? balanceOf(to) : 0;

        bytes32 destination = ensure_token_account(to);
        bytes32 source = HelperProgram.ata(from, mint_id);
        // Direct CALL signs as external_auth(address(this)), not
        // external_auth(msg.sender) — the wrapper must be from's SPL delegate.
        Token2022HookedTransfer.transferChecked(
            source,
            mint_id,
            destination,
            self_pda,
            uint64(value),
            decimals,
            tail
        );

        uint256 delivered = value;
        if (feeArmed) {
            uint256 afterBalance = balanceOf(to);
            delivered = to == from
                ? value - (beforeBalance - afterBalance)
                : afterBalance - beforeBalance;
        }
        emit Transfer(from, to, delivered);
        return true;
    }

    /// @notice The base bridge-out signature cannot carry hook accounts.
    function bridgeOutToSolana(bytes32, uint256)
        public
        pure
        override
        returns (bool)
    {
        revert HookAccountPlanRequired();
    }

    function bridgeOutToSolanaWithHookAccounts(
        bytes32 solanaRecipient,
        uint256 value,
        ICrossProgramInvocation.AccountMeta[] calldata hookMetas
    ) external returns (bool) {
        require(value <= type(uint64).max, "Bridge amount exceeds uint64");
        require(solanaRecipient != bytes32(0), "Solana recipient cannot be zero");
        (, ICrossProgramInvocation.AccountMeta[] calldata tail) = _validateCurrentPlan(hookMetas);

        bytes32 destination = ensureRecipientAta(solanaRecipient);
        bytes32 source = HelperProgram.ata(msg.sender, mint_id);
        // Same authority shift as _hookedTransfer — the wrapper must be
        // msg.sender's SPL delegate.
        Token2022HookedTransfer.transferChecked(
            source,
            mint_id,
            destination,
            self_pda,
            uint64(value),
            decimals,
            tail
        );

        emit BridgedOutToSolana(
            msg.sender, solanaRecipient, mint_id, value
        );
        return true;
    }
}
