// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import "../rome_evm_account.sol";
import {Convert} from "../convert.sol";
import {AssociatedSplToken} from "./associated_spl_token.sol";

library UnifiedLiquidity {
    bytes32 public constant default_salt = bytes32("PAYER");

    function get_payer_account(address user) public view returns (bytes32) {
        return RomeEVMAccount.get_payer(user, default_salt);
    }

    function create_payer_account(uint64 lamports) public {
        RomeEVMAccount.create_payer(msg.sender, lamports, default_salt);
    }

    function get_token_account(address user, bytes32 mint_id) public view returns (bytes32) {
        revert("get_token_account is not implemented");
        // bytes32 user_pda = get_payer_account(user);
        // (bytes32 token_account,) = AssociatedSplToken.get_associated_token_address_with_program_id(user_pda, mint_id);
        // return token_account;
    }
}