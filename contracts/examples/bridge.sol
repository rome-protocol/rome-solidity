// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {CpiProgram, SystemProgram, ISystemProgram, HelperProgram, ICrossProgramInvocation} from "../interface.sol";
import {Convert} from "../convert.sol";
import {SplTokenLib} from "../spl_token/spl_token.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";
import {AssociatedSplToken} from "../spl_token/associated_spl_token.sol";

/// @title BridgeExample
/// @notice Reference patterns for bridge-adjacent operations (unwrap, ATA
///         derivation, balance probe). NOT a production contract — this is
///         a sandbox for adapter authors.
///
/// @dev    Demonstrates canonical post-2026-05 surface:
///         - Unwrap leg uses `HelperProgram.deposit_from_ata` (the historical
///           `unwrap_spl_to_gas` precompile was retired in the #348-#354
///           consolidation).
///         - User-keyed ATA derivation uses `HelperProgram.ata(address, bytes32)`
///           single-dispatch path — saves ~152K Solana CU vs the two-hop
///           pattern.
///         - For raw Solana-pubkey-keyed ATAs (chain gas-pool, fee accumulator,
///           pool authority), `AssociatedSplToken.get_associated_token_address_with_program_id`
///           is the right path — HelperProgram.ata takes an EVM `address`, not
///           a `bytes32` Solana pubkey.
///
///         For the full HelperProgram method inventory by example, see
///         `contracts/examples/helper.sol` (helper_example).
contract BridgeExample {
    /// Unwrap leg of the gas-token bridge: wrapper SPL balance in caller's
    /// ATA becomes native Rome gas credit in caller's Balance PDA. Caller
    /// must have a non-zero balance in their wrapper ATA.
    function unwrap_spl_to_gas(uint256 value) external {
        (bool success, bytes memory result) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature("deposit_from_ata(uint256)", value)
        );
        require(success, string(Convert.revert_msg(result)));
    }

    /// Chain gas-pool ATA — keyed by the per-chain `CONTRACT_SOL_WALLET`
    /// PDA which is a raw Solana pubkey, not an EVM address. Uses
    /// `AssociatedSplToken.get_associated_token_address_with_program_id`
    /// because HelperProgram.ata only accepts EVM `address`.
    function rome_wallet_ata() public view returns (string memory) {
        bytes32 rome_program = SystemProgram.rome_evm_program_id();

        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](2);
        seeds[0] = ISystemProgram.Seed(Convert.chain_id_le(block.chainid));
        seeds[1] = ISystemProgram.Seed(bytes("CONTRACT_SOL_WALLET"));

        (bytes32 wallet,) = SystemProgram.find_program_address(rome_program, seeds);

        bytes32 ata_b32 = _ata_for_key(wallet);
        bytes memory ata_b58 = SystemProgram.bytes32_to_base58(ata_b32);

        return string(ata_b58);
    }

    /// User's gas-mint ATA — canonical single-dispatch via HelperProgram.ata.
    /// Replaces the prior two-hop `RomeEVMAccount.pda(msg.sender)` +
    /// `AssociatedSplToken.get_associated_token_address_with_program_id`
    /// pattern. Saves ~152K Solana CU per call.
    function user_ata() public view returns (string memory) {
        bytes32 mint_id = SystemProgram.mint_id();
        require(mint_id != bytes32(0), "Rollup doesn't use SPL as gas token");

        bytes32 ata_b32 = HelperProgram.ata(msg.sender, mint_id);
        bytes memory ata_b58 = SystemProgram.bytes32_to_base58(ata_b32);

        return string(ata_b58);
    }

    function spl_balance(string memory token_account) public view returns (uint64) {
        bytes32 ata_b32 = SystemProgram.base58_to_bytes32(bytes(token_account));
        return SplTokenLib.load_token_amount(ata_b32, address(CpiProgram));
    }

    /// Bootstrap caller's unified Rome user PDA. Funds it to rent-exempt
    /// threshold so subsequent CPIs the user signs can succeed. Idempotent
    /// (no-op if already funded).
    function create_payer() public {
        RomeEVMAccount.create_payer(msg.sender, 10000000);
    }

    /// Idempotent ATA-create for the caller against the chain's gas mint —
    /// canonical single-dispatch via `HelperProgram.create_ata(address, bytes32)`.
    /// Replaces the prior pattern of constructing
    /// `AssociatedSplToken.create_associated_token_account_idempotent` calldata
    /// and dispatching through `CpiProgram.invoke_signed` with PAYER salt
    /// (PAYER_PDA collapsed into the unified user PDA in rome-solidity 0acabea).
    function create_user_ata() external {
        bytes32 mint_id = SystemProgram.mint_id();
        require(mint_id != bytes32(0), "Rollup doesn't use SPL as gas token");

        (bool success, bytes memory result) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature("create_ata(address,bytes32)", msg.sender, mint_id)
        );
        require(success, string(Convert.revert_msg(result)));
    }

    /// Internal — ATA derivation against a raw Solana pubkey (used for
    /// chain-side keys, e.g. gas pool wallet). HelperProgram.ata is the
    /// EVM-address equivalent.
    function _ata_for_key(bytes32 owner_pubkey) internal view returns (bytes32) {
        bytes32 mint_id = SystemProgram.mint_id();
        require(mint_id != bytes32(0), "Rollup doesn't use SPL as gas token");

        (, bytes32 spl_program, , , , ) = CpiProgram.account_info(mint_id);

        return AssociatedSplToken.get_associated_token_address_with_program_id(
            owner_pubkey,
            mint_id,
            spl_program,
            AssociatedSplToken.ASSOCIATED_TOKEN_PROGRAM_ID
        );
    }
}
