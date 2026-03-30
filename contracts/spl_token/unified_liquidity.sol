// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import "../rome_evm_account.sol";
import {Convert} from "../convert.sol";
import {AssociatedSplTokenLib} from "./associated_spl_token.sol";

library UnifiedLiquidity {
    bytes32 public constant default_salt = keccak256(bytes("PAYER"));

    function get_payer_account(address user) public view returns (bytes32) {
        return RomeEVMAccount.get_payer(user, default_salt);
    }

    function create_payer_account(uint64 lamports) public {
        RomeEVMAccount.create_payer(msg.sender, lamports, default_salt);
    }

    function get_token_account(address user, bytes32 mint_id) public view returns (bytes32) {
        bytes32 user_pda = get_payer_account(user);
        (bytes32 token_account,) = AssociatedSplTokenLib.associated_token_address(user_pda, mint_id);
        return token_account;
    }
}