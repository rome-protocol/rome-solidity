// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ICrossProgramInvocation} from "../interface.sol";
import "../convert.sol";

library SystemProgramLib {
    bytes32 internal constant PROGRAM_ID = 0x0000000000000000000000000000000000000000000000000000000000000000;

    bytes32 internal constant ID =
        0x0000000000000000000000000000000000000000000000000000000000000000;

    bytes32 internal constant RENT_ID =
        0x06a7d517192c5c51218cc94c3d4af17f58daee089ba1fd44e3dbd98a00000000;

    struct Instruction {
        bytes32 program_id;
        ICrossProgramInvocation.AccountMeta[] accounts;
        bytes data;
    }

    function transfer(
        bytes32 from_pubkey,
        bytes32 to_pubkey,
        uint64 lamports
    ) internal pure returns (Instruction memory ix) {
        ICrossProgramInvocation.AccountMeta[] memory account_metas =
            new ICrossProgramInvocation.AccountMeta[](2);
        account_metas[0] = _meta(from_pubkey, true, true);
        account_metas[1] = _meta(to_pubkey, false, true);

        ix.program_id = ID;
        ix.accounts = account_metas;
        ix.data = abi.encodePacked(_u32le(2), Convert.u64le(lamports));
        return ix;
    }

    function _meta(bytes32 pubkey, bool is_signer, bool is_writable)
        internal
        pure
        returns (ICrossProgramInvocation.AccountMeta memory)
    {
        return ICrossProgramInvocation.AccountMeta({
            pubkey: pubkey,
            is_signer: is_signer,
            is_writable: is_writable
        });
    }

    function _u32le(uint32 x) internal pure returns (bytes4) {
        return bytes4(
            (uint32(x & 0x000000FF) << 24) |
            (uint32(x & 0x0000FF00) << 8) |
            (uint32(x & 0x00FF0000) >> 8) |
            (uint32(x & 0xFF000000) >> 24)
        );
    }
}
