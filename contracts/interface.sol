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
}

interface IWithdraw {
    function withdrawal(bytes32 owner) payable external;
}

interface IUnwrapSplToGas {
    // Convert ERC20-SPL wrapper balance -> native gas balance for the caller.
    // `amount` is in wei (18 decimals) and must be a multiple of
    // 10^(18 - mint_decimals). Non-payable. Only valid on chains with
    // chain_mint_id set. Reverts with Unimplemented otherwise.
    function unwrap_spl_to_gas(uint256 amount) external;
}

interface IWrapGasToSpl {
    // Convert native gas balance -> ERC20-SPL wrapper balance for the caller.
    // `amount` is in wei (18 decimals) and must be a multiple of
    // 10^(18 - mint_decimals). Non-payable. Only valid on chains with
    // chain_mint_id set. Reverts with Unimplemented otherwise.
    function wrap_gas_to_spl(uint256 amount) external;
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
    function invoke(bytes32 program_id, AccountMeta[] memory accounts, bytes memory data) external;
    function invoke_signed(bytes32 program_id, AccountMeta[] memory accounts, bytes memory data, bytes32[] memory seeds) external;
    // return value: lamports, owner, is_signer, is_writable, executable, data
    function account_info(bytes32 pubkey) external view returns(uint64, bytes32, bool, bool, bool, bytes memory);
}

address constant system_program_address = address(0xfF00000000000000000000000000000000000007);
address constant cpi_program_address = address(0xFF00000000000000000000000000000000000008);
address constant withdraw_address = address(0x4200000000000000000000000000000000000016);
address constant unwrap_spl_to_gas_address = address(0x4200000000000000000000000000000000000017);
address constant wrap_gas_to_spl_address = address(0x4200000000000000000000000000000000000018);

ISystemProgram constant SystemProgram = ISystemProgram(system_program_address);
ICrossProgramInvocation constant CpiProgram = ICrossProgramInvocation(cpi_program_address);
IWithdraw constant Withdraw = IWithdraw(withdraw_address);
IUnwrapSplToGas constant UnwrapSplToGas = IUnwrapSplToGas(unwrap_spl_to_gas_address);
IWrapGasToSpl constant WrapGasToSpl = IWrapGasToSpl(wrap_gas_to_spl_address);






