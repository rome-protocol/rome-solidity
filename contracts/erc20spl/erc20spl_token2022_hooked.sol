// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SPL_ERC20Base, ERC20Users} from "./erc20spl.sol";
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
/// @notice Direct-CPI ERC-20 surface for a Token-2022 mint with an armed
///         Transfer Hook.
/// @dev Transfer entrypoints take the complete, already-resolved hook account
///      tail. The wrapper validates the invariant hook-program + validation-PDA
///      trailer, then forwards the tail unchanged to Token-2022. Resolution is
///      application/client work because ExtraAccountMetaList entries can depend
///      on the instruction, endpoint accounts and account data.
contract SPL_ERC20_Token2022Hooked is SPL_ERC20Base {
    bytes internal constant EXTRA_ACCOUNT_METAS_SEED = "extra-account-metas";

    bytes32 public immutable hook_program;
    bytes32 public immutable validation_account;

    error ArmedTransferHookRequired(bytes32 mint);
    error Token2022MintRequired(bytes32 mint, bytes32 tokenProgram);
    error HookAccountPlanRequired();
    error HookConfigurationChanged(
        bytes32 expectedHookProgram,
        bytes32 actualHookProgram
    );

    constructor(
        bytes32 _mint_id,
        address _cpi_program,
        string memory name_,
        string memory symbol_,
        ERC20Users users_
    ) SPL_ERC20Base(_mint_id, _cpi_program, name_, symbol_, users_, true) {
        (bytes32 tokenProgram, , bytes32 hookProgram, ,) =
            HelperProgram.mint_info(_mint_id);
        if (tokenProgram != SolanaConstants.TOKEN_2022_PROGRAM) {
            revert Token2022MintRequired(_mint_id, tokenProgram);
        }
        if (hookProgram == bytes32(0)) {
            revert ArmedTransferHookRequired(_mint_id);
        }

        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](2);
        seeds[0] = ISystemProgram.Seed(EXTRA_ACCOUNT_METAS_SEED);
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(_mint_id));
        (bytes32 validation, ) =
            SystemProgram.find_program_address(hookProgram, seeds);

        hook_program = hookProgram;
        validation_account = validation;
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
        _users.ensure_user(msg.sender);
        return _hookedTransfer(msg.sender, to, value, hookMetas);
    }

    function transferFromWithHookAccounts(
        address from,
        address to,
        uint256 value,
        ICrossProgramInvocation.AccountMeta[] calldata hookMetas
    ) external returns (bool) {
        _users.ensure_user(msg.sender);
        // Post-the delegatecall gate: transferChecked's authority is fixed to the wrapper's
        // own PDA regardless of msg.sender (§0.2), so SPL's own delegate
        // check no longer distinguishes which caller invoked this. The
        // inherited EVM allowance (SPL_ERC20Base §4.1) is now the only
        // per-spender gate — spend it exactly as the base transferFrom does.
        _spendAllowance(from, msg.sender, value);
        return _hookedTransfer(from, to, value, hookMetas);
    }

    function _validateCurrentPlan(
        ICrossProgramInvocation.AccountMeta[] calldata hookMetas
    ) internal view returns (uint16 feeBps) {
        (bytes32 tokenProgram, , bytes32 currentHookProgram, uint16 currentFeeBps,) =
            HelperProgram.mint_info(mint_id);
        if (tokenProgram != SolanaConstants.TOKEN_2022_PROGRAM) {
            revert Token2022MintRequired(mint_id, tokenProgram);
        }
        if (currentHookProgram != hook_program) {
            revert HookConfigurationChanged(hook_program, currentHookProgram);
        }
        Token2022HookedTransfer.validate(
            hook_program, validation_account, hookMetas
        );
        return currentFeeBps;
    }

    function _hookedTransfer(
        address from,
        address to,
        uint256 value,
        ICrossProgramInvocation.AccountMeta[] calldata hookMetas
    ) internal returns (bool) {
        require(value <= type(uint64).max, "Transfer amount exceeds uint64");
        uint16 feeBps = _validateCurrentPlan(hookMetas);
        bool feeArmed = feeBps > 0;
        uint256 beforeBalance = feeArmed ? balanceOf(to) : 0;

        bytes32 destination = ensure_token_account(to);
        bytes32 source = HelperProgram.ata(from, mint_id);
        // Post-the delegatecall gate: a direct CALL signs as external_auth(address(this)), not
        // external_auth(msg.sender) — the wrapper itself must be from's SPL
        // delegate (one-time approve_spl, exactly as erc20spl.sol §4.1).
        Token2022HookedTransfer.transferChecked(
            source,
            mint_id,
            destination,
            RomeEVMAccount.pda(address(this)),
            uint64(value),
            decimals,
            hookMetas
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
        _validateCurrentPlan(hookMetas);

        bytes32 destination = ensureRecipientAta(solanaRecipient);
        bytes32 source = HelperProgram.ata(msg.sender, mint_id);
        // Post-the delegatecall gate: same authority shift as _hookedTransfer above — the
        // wrapper must be msg.sender's SPL delegate.
        Token2022HookedTransfer.transferChecked(
            source,
            mint_id,
            destination,
            RomeEVMAccount.pda(address(this)),
            uint64(value),
            decimals,
            hookMetas
        );

        emit BridgedOutToSolana(
            msg.sender, solanaRecipient, mint_id, value
        );
        return true;
    }
}
