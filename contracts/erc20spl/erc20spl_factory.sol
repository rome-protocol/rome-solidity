// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./erc20spl.sol";
import "../mpl_token_metadata/lib.sol";
import {MplTokenMetadataLib} from "../mpl_token_metadata/lib.sol";

contract ERC20SPLFactory {
    mapping (bytes32 => address) public token_by_mint;
    bytes32 public immutable mpl_token_metadata_program;
    address public immutable cpi_program;
    ERC20Users private _users;

    constructor(address _cpi_program) {
        cpi_program = _cpi_program;
        _users = new ERC20Users();
    }

    function add_spl_token_with_metadata(bytes32 mint)
    public
    returns (address) {
        require(token_by_mint[mint] == address(0), "Token exists");

        (bool metadata_exists, MplTokenMetadataLib.Metadata memory metadata) = MplTokenMetadataLib.load_metadata(
            mint, mpl_token_metadata_program, cpi_program
        );
        require(metadata_exists, "Metadata does not exist");
    
        SPL_ERC20 new_contract = new SPL_ERC20(mint, cpi_program, metadata.name, metadata.symbol, _users);
        token_by_mint[mint] = address(new_contract);
        return address(new_contract);
    }

    function add_spl_token_no_metadata(bytes32 mint, string memory name, string memory symbol)
    public
    returns (address) {
        require(token_by_mint[mint] == address(0), "Token exists");
        SPL_ERC20 new_contract = new SPL_ERC20(mint, cpi_program, name, symbol, _users);
        token_by_mint[mint] = address(new_contract);
        return address(new_contract);
    }
}
