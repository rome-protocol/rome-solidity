// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ISystemProgram {
    struct Seed{
        bytes item;
    }
    // eth_calls
    function program_id() external view returns(bytes32);
    function rome_evm_program_id() external view returns(bytes32);
    function find_program_address(bytes32 program, Seed[] memory seeds) external view returns (bytes32, uint8);
    function bytes32_to_base58(bytes32) external view returns(bytes memory);
    function base58_to_bytes32(bytes memory) external view returns(bytes32);
    function operator() external view returns(bytes32);
}

interface IWithdraw {
    function withdrawal(bytes32 owner) payable external;
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

ISystemProgram constant SystemProgram = ISystemProgram(system_program_address);
ICrossProgramInvocation constant CpiProgram = ICrossProgramInvocation(cpi_program_address);
IWithdraw constant Withdraw = IWithdraw(withdraw_address);



contract cu_example {
    bytes32 public constant SYSTEM_PROGRAM_ID = 0x0000000000000000000000000000000000000000000000000000000000000000;
    bytes32 constant ROME_EVM_PROGRAM_ID = 0xaeeacad8c756d3c847e1d4afc19327296446175d95424b8ba7892ae55de52967;
    
    function create_payer_account1() external {

        bytes32 rome_program = SystemProgram.rome_evm_program_id();
        bytes32 from = SystemProgram.operator();
        bytes memory salt = bytes("PAYER");

        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](3);
        seeds[0] = ISystemProgram.Seed(bytes("EXTERNAL_AUTHORITY"));
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(msg.sender));
        seeds[2] = ISystemProgram.Seed(salt);

        (bytes32 to_,) = SystemProgram.find_program_address(rome_program, seeds);
        // bytes32 to = 0xaeeacad8c756d3c847e1d4afc19327296446175d95424b8ba7892ae55de52967;
        bytes32 to = 0xec81105112a257d61df4cf5f13ee0a1b019197c8c5343b4f2a7ec8846ae22c1a;

        ICrossProgramInvocation.AccountMeta[] memory meta = new ICrossProgramInvocation.AccountMeta[](2);
        meta[0] = ICrossProgramInvocation.AccountMeta(from, true, true);
        meta[1] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[2] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[3] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[4] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[5] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[6] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[7] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[8] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[9] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[10] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[11] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[12] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[13] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[14] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[15] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[16] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[17] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[18] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[19] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[20] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[21] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[22] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[23] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[24] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[25] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[26] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[27] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[28] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[29] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[30] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[31] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[32] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[33] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[34] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[35] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[36] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[37] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[38] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[39] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[40] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[41] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[42] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[43] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[44] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[45] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[46] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[47] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[48] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[49] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[50] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[51] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[52] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[53] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[54] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[55] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[56] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[57] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[58] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[59] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[60] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[61] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[62] = ICrossProgramInvocation.AccountMeta(to, false, true);
        // meta[63] = ICrossProgramInvocation.AccountMeta(to, false, true);

        bytes memory byte_1 = new bytes(4);
        byte_1[0] = bytes1(uint8(2));

        bytes memory byte_2 = new bytes(8);
        for (uint i = 0; i < 8; i++) {
            byte_2[i] = bytes1(uint8(1000000000 >> (8 * i)));
        }

        bytes memory data =abi.encodePacked(
            byte_1,
            byte_2
        );
            
        (bool success, ) = address(CpiProgram).delegatecall(
         abi.encodeWithSignature("invoke(bytes32,(bytes32,bool,bool)[],bytes)", ROME_EVM_PROGRAM_ID, meta, abi.encodePacked(data))
        );
        require (success, "revert");    }
}

