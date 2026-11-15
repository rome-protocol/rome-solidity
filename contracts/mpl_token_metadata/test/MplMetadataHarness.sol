// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MplTokenMetadataLib} from "../lib.sol";

/// @notice Exposes `MplTokenMetadataLib.load_metadata` for `tests/mpl_token_metadata/load-metadata.test.ts`.
contract MplMetadataHarness {
    function load(bytes32 mint, bytes32 program, address cpi)
        external
        view
        returns (bool found, bytes32 metadataMint, string memory name, string memory symbol)
    {
        (bool ok, MplTokenMetadataLib.Metadata memory md) = MplTokenMetadataLib.load_metadata(mint, program, cpi);
        return (ok, md.mint, md.name, md.symbol);
    }
}
