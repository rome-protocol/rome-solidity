// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./erc20spl.sol";
import "../mpl_token_metadata/lib.sol";

contract ERC20SPLFactory {
    mapping (bytes32 => address) public token_by_mint;
    address public immutable cpi_program;

    constructor(address _cpi_program) {
        cpi_program = _cpi_program;
    }

    function add_spl_token(bytes32 mint)
    public
    returns (address) {
        require(token_by_mint[mint] == address(0), "Token exists");
        SPL_ERC20 new_contract = new SPL_ERC20(mint, cpi_program);
        token_by_mint[mint] = address(new_contract);
        return address(new_contract);
    }
}
