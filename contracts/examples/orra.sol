// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../rome_evm_account.sol";
import "../system_program/system_program.sol";
import {ICrossProgramInvocation as icpi, CpiProgram as cpi} from "../interface.sol";

contract example {
    function create_payer_account() external {
        // bytes32 salt = Convert.bytes_to_bytes32(bytes("PAYER"));
        bytes32 salt = bytes32(uint256(10));
        // bytes32 key = pda_with_salt(msg.sender, salt);

        // bytes32 rome_program = SystemProgram.rome_evm_program_id();
        create_payer(msg.sender, 1000000000, salt);
    }
    
    function create_payer(address user, uint64 lamports, bytes32 salt)  public {
        bytes32 key = pda_with_salt(user, salt);

        (uint64 lamports_,,,,,) = CpiProgram.account_info(key);
        if (lamports_ == 0) {
            require(lamports >= minimum_balance(0), "insufficient lamports, rent-exemption value is 890880");
        }

        bytes32 from = SystemProgram.operator();
        SystemProgramLib.transfer(from, key, lamports);
    }

    function pda_with_salt(address user, bytes32 salt) internal view returns (bytes32) {
        bytes32 rome_program = SystemProgram.rome_evm_program_id();
        ISystemProgram.Seed[] memory seeds = authority_seeds_with_salt(user, salt);
        (bytes32 key,) = SystemProgram.find_program_address(rome_program, seeds);
        return key;
    }

    function authority_seeds_with_salt(address user, bytes32 salt) internal pure returns(ISystemProgram.Seed[] memory) {
        bytes memory salt_ = Convert.bytes32_to_bytes(salt);

        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](3);
        seeds[0] = ISystemProgram.Seed(bytes("EXTERNAL_AUTHORITY"));
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(user));
        seeds[2] = ISystemProgram.Seed(salt_);

        return seeds;
    }

    function minimum_balance(uint64 len) internal pure returns(uint64) {
        // (ACCOUNT_STORAGE_OVERHEAD + len) * LAMPORTS_PER_BYTE_YEAR * EXEMPTION_THRESHOLD
        return (128 + len) * 3480 * 2;
    }
}

contract orra_example {
    bytes32 public constant ORRA_PROGRAM_ID = 0x0c011697d4d36ab9571d6cfd88c3c45c6c9249cece2756ccd780781bb1f981d2;

    function create_payer_account() external {
        bytes32 salt = Convert.bytes_to_bytes32(bytes("PAYER"));
        RomeEVMAccount.create_payer(msg.sender, 1000000000, salt);
    }

    function create_sub_user_key() external {
        bytes32 salt = Convert.bytes_to_bytes32(bytes("SUB_USER_KEY"));
        bytes32 key = RomeEVMAccount.pda_with_salt(msg.sender, salt);

        (uint64 lamports,,,,,) = CpiProgram.account_info(key);
        if (lamports == 0) {
            uint64 rent = RomeEVMAccount.minimum_balance(0);
            SystemProgramLib.transfer(SystemProgram.operator(), key, rent);
        }
    }

    function user_trade_key(bytes32 key)  public view returns (bytes32) {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](2);
        seeds[0] = ISystemProgram.Seed(bytes("user_trade"));
        seeds[1] = ISystemProgram.Seed(Convert.bytes32_to_bytes(key));
        (bytes32 user_trade,) = SystemProgram.find_program_address(ORRA_PROGRAM_ID, seeds);
        return user_trade;
    }

    function ix_create_user_trade() external {
        bytes32 signer = RomeEVMAccount.pda(msg.sender);
        bytes32 salt = Convert.bytes_to_bytes32(bytes("PAYER"));
        bytes32 payer = RomeEVMAccount.pda_with_salt(msg.sender, salt);
        bytes32 user_trade = user_trade_key(signer);

        icpi.AccountMeta[] memory meta = new icpi.AccountMeta[](4);
        meta[0] = icpi.AccountMeta(signer, true, true);
        meta[1] = icpi.AccountMeta(payer, true, true);
        meta[2] = icpi.AccountMeta(user_trade, false, true);
        meta[3] = icpi.AccountMeta(SystemProgramLib.PROGRAM_ID, false, false);

        // sha256("global:create_user_trade")[0..8]
        bytes memory data = hex"e8eb3ac287f89901";

        bytes32[] memory salts = new bytes32[](1);
        salts[0] = salt;

        (bool success, bytes memory result) = address(cpi).delegatecall(
            abi.encodeWithSignature(
                "invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])",
                ORRA_PROGRAM_ID,
                meta,
                abi.encodePacked(data),
                salts
            )
        );
        require (success, string(Convert.revert_msg(result)));
    }

    // AnchorError caused by account: user_trade. Error Code: AccountNotInitialized. 
    // Error Number: 3012. Error Message: The program expected this account to be already initialized.
    function ix_create_sub_user_trade() external {
        bytes32 signer = RomeEVMAccount.pda(msg.sender);
        bytes32 salt = Convert.bytes_to_bytes32(bytes("PAYER"));
        bytes32 payer = RomeEVMAccount.pda_with_salt(msg.sender, salt);
        bytes32 user_trade = user_trade_key(signer);

        bytes32 sub_user_key_salt = Convert.bytes_to_bytes32(bytes("SUB_USER_KEY"));
        bytes32 sub_user_key = RomeEVMAccount.pda_with_salt(msg.sender, sub_user_key_salt);
        bytes32 sub_user_trade = user_trade_key(sub_user_key);

        icpi.AccountMeta[] memory meta = new icpi.AccountMeta[](4);
        meta[0] = icpi.AccountMeta(signer, true, true);
        meta[1] = icpi.AccountMeta(payer, true, true);
        meta[2] = icpi.AccountMeta(user_trade, false, true);
        meta[2] = icpi.AccountMeta(sub_user_trade, false, true);
        meta[3] = icpi.AccountMeta(SystemProgramLib.PROGRAM_ID, false, false);

        // sha256("global:create_sub_user_trade")[0..8]
        bytes memory discriminator = hex"4dc96f492fe5f4a1";
        bytes memory data = bytes.concat(discriminator, sub_user_key);

        bytes32[] memory salts = new bytes32[](1);
        salts[0] = salt;

        (bool success, bytes memory result) = address(cpi).delegatecall(
            abi.encodeWithSignature(
                "invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])",
                ORRA_PROGRAM_ID,
                meta,
                abi.encodePacked(data),
                salts
            )
        );
        require (success, string(Convert.revert_msg(result)));
    }
}
