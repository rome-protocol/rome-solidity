// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ICrossProgramInvocation, CpiProgram} from "../interface.sol";
import {SystemProgramInstructionData as Ix} from  "./instruction_data.sol";
import "../convert.sol";

library SystemProgramLib {
    bytes32 public constant PROGRAM_ID = 0x0000000000000000000000000000000000000000000000000000000000000000;

    bytes32 internal constant ID =
        0x0000000000000000000000000000000000000000000000000000000000000000;
    bytes32 internal constant RECENT_BLOCKHASHES_ID =
        0x06a7d517192c568ee08a845f73d29788cf035c3145b21ab344d8062ea9400000;
    bytes32 internal constant RENT_ID =
        0x06a7d517192c5c51218cc94c3d4af17f58daee089ba1fd44e3dbd98a00000000;

    uint64 internal constant NONCE_STATE_SIZE = 80;

    struct Instruction {
        bytes32 program_id;
        ICrossProgramInvocation.AccountMeta[] accounts;
        bytes data;
    }

    function create_account(
        bytes32 from_pubkey,
        bytes32 to_pubkey,
        uint64 lamports,
        uint64 space,
        bytes32 owner
    ) public pure returns (Instruction memory ix) {
        ICrossProgramInvocation.AccountMeta[] memory account_metas =
            new ICrossProgramInvocation.AccountMeta[](2);
        account_metas[0] = _meta(from_pubkey, true, true);
        account_metas[1] = _meta(to_pubkey, true, true);

        ix.program_id = ID;
        ix.accounts = account_metas;
        ix.data = abi.encodePacked(
            _u32le(0),
            Convert.u64le(lamports),
            Convert.u64le(space),
            owner
        );
    }

    function create_account_with_seed(
        bytes32 from_pubkey,
        bytes32 to_pubkey,
        bytes32 base,
        string memory seed,
        uint64 lamports,
        uint64 space,
        bytes32 owner
    ) public pure returns (Instruction memory ix) {
        ICrossProgramInvocation.AccountMeta[] memory account_metas =
            new ICrossProgramInvocation.AccountMeta[](3);
        account_metas[0] = _meta(from_pubkey, true, true);
        account_metas[1] = _meta(to_pubkey, false, true);
        account_metas[2] = _meta(base, true, false);

        ix.program_id = ID;
        ix.accounts = account_metas;
        ix.data = abi.encodePacked(
            _u32le(3),
            base,
            _encode_string(seed),
            Convert.u64le(lamports),
            Convert.u64le(space),
            owner
        );
    }

    function assign(bytes32 pubkey, bytes32 owner)
        public
        pure
        returns (Instruction memory ix)
    {
        ICrossProgramInvocation.AccountMeta[] memory account_metas =
            new ICrossProgramInvocation.AccountMeta[](1);
        account_metas[0] = _meta(pubkey, true, true);

        ix.program_id = ID;
        ix.accounts = account_metas;
        ix.data = abi.encodePacked(_u32le(1), owner);
    }

    function assign_with_seed(
        bytes32 address_,
        bytes32 base,
        string memory seed,
        bytes32 owner
    ) public pure returns (Instruction memory ix) {
        ICrossProgramInvocation.AccountMeta[] memory account_metas =
            new ICrossProgramInvocation.AccountMeta[](2);
        account_metas[0] = _meta(address_, false, true);
        account_metas[1] = _meta(base, true, false);

        ix.program_id = ID;
        ix.accounts = account_metas;
        ix.data = abi.encodePacked(
            _u32le(10),
            base,
            _encode_string(seed),
            owner
        );
    }

    function transfer(
        bytes32 from_pubkey,
        bytes32 to_pubkey,
        uint64 lamports
    ) public pure returns (Instruction memory ix) {
        ICrossProgramInvocation.AccountMeta[] memory account_metas =
            new ICrossProgramInvocation.AccountMeta[](2);
        account_metas[0] = _meta(from_pubkey, true, true);
        account_metas[1] = _meta(to_pubkey, false, true);

        ix.program_id = ID;
        ix.accounts = account_metas;
        ix.data = abi.encodePacked(_u32le(2), Convert.u64le(lamports));
    }

    function transfer_with_seed(
        bytes32 from_pubkey,
        bytes32 from_base,
        string memory from_seed,
        bytes32 from_owner,
        bytes32 to_pubkey,
        uint64 lamports
    ) public pure returns (Instruction memory ix) {
        ICrossProgramInvocation.AccountMeta[] memory account_metas =
            new ICrossProgramInvocation.AccountMeta[](3);
        account_metas[0] = _meta(from_pubkey, false, true);
        account_metas[1] = _meta(from_base, true, false);
        account_metas[2] = _meta(to_pubkey, false, true);

        ix.program_id = ID;
        ix.accounts = account_metas;
        ix.data = abi.encodePacked(
            _u32le(11),
            Convert.u64le(lamports),
            _encode_string(from_seed),
            from_owner
        );
    }

    function allocate(bytes32 pubkey, uint64 space)
        public
        pure
        returns (Instruction memory ix)
    {
        ICrossProgramInvocation.AccountMeta[] memory account_metas =
            new ICrossProgramInvocation.AccountMeta[](1);
        account_metas[0] = _meta(pubkey, true, true);

        ix.program_id = ID;
        ix.accounts = account_metas;
        ix.data = abi.encodePacked(_u32le(8), Convert.u64le(space));
    }

    function allocate_with_seed(
        bytes32 address_,
        bytes32 base,
        string memory seed,
        uint64 space,
        bytes32 owner
    ) public pure returns (Instruction memory ix) {
        ICrossProgramInvocation.AccountMeta[] memory account_metas =
            new ICrossProgramInvocation.AccountMeta[](2);
        account_metas[0] = _meta(address_, false, true);
        account_metas[1] = _meta(base, true, false);

        ix.program_id = ID;
        ix.accounts = account_metas;
        ix.data = abi.encodePacked(
            _u32le(9),
            base,
            _encode_string(seed),
            Convert.u64le(space),
            owner
        );
    }

    function transfer_many(bytes32 from_pubkey, RecipientLamports[] memory to_lamports)
        public
        pure
        returns (Instruction[] memory ixs)
    {
        ixs = new Instruction[](to_lamports.length);
        for (uint256 i = 0; i < to_lamports.length; i++) {
            ixs[i] = transfer(from_pubkey, to_lamports[i].to_pubkey, to_lamports[i].lamports);
        }
    }

    function create_nonce_account_with_seed(
        bytes32 from_pubkey,
        bytes32 nonce_pubkey,
        bytes32 base,
        string memory seed,
        bytes32 authority,
        uint64 lamports
    ) public pure returns (Instruction[] memory ixs) {
        ixs = new Instruction[](2);
        ixs[0] = create_account_with_seed(
            from_pubkey,
            nonce_pubkey,
            base,
            seed,
            lamports,
            NONCE_STATE_SIZE,
            ID
        );

        ICrossProgramInvocation.AccountMeta[] memory metas =
            new ICrossProgramInvocation.AccountMeta[](3);
        metas[0] = _meta(nonce_pubkey, false, true);
        metas[1] = _meta(RECENT_BLOCKHASHES_ID, false, false);
        metas[2] = _meta(RENT_ID, false, false);

        ixs[1] = Instruction({
            program_id: ID,
            accounts: metas,
            data: abi.encodePacked(_u32le(6), authority)
        });
    }

    function create_nonce_account(
        bytes32 from_pubkey,
        bytes32 nonce_pubkey,
        bytes32 authority,
        uint64 lamports
    ) public pure returns (Instruction[] memory ixs) {
        ixs = new Instruction[](2);
        ixs[0] = create_account(
            from_pubkey,
            nonce_pubkey,
            lamports,
            NONCE_STATE_SIZE,
            ID
        );

        ICrossProgramInvocation.AccountMeta[] memory metas =
            new ICrossProgramInvocation.AccountMeta[](3);
        metas[0] = _meta(nonce_pubkey, false, true);
        metas[1] = _meta(RECENT_BLOCKHASHES_ID, false, false);
        metas[2] = _meta(RENT_ID, false, false);

        ixs[1] = Instruction({
            program_id: ID,
            accounts: metas,
            data: abi.encodePacked(_u32le(6), authority)
        });
    }

    function advance_nonce_account(bytes32 nonce_pubkey, bytes32 authorized_pubkey)
        public
        pure
        returns (Instruction memory ix)
    {
        ICrossProgramInvocation.AccountMeta[] memory account_metas =
            new ICrossProgramInvocation.AccountMeta[](3);
        account_metas[0] = _meta(nonce_pubkey, false, true);
        account_metas[1] = _meta(RECENT_BLOCKHASHES_ID, false, false);
        account_metas[2] = _meta(authorized_pubkey, true, false);

        ix.program_id = ID;
        ix.accounts = account_metas;
        ix.data = abi.encodePacked(_u32le(4));
    }

    function withdraw_nonce_account(
        bytes32 nonce_pubkey,
        bytes32 authorized_pubkey,
        bytes32 to_pubkey,
        uint64 lamports
    ) public pure returns (Instruction memory ix) {
        ICrossProgramInvocation.AccountMeta[] memory account_metas =
            new ICrossProgramInvocation.AccountMeta[](5);
        account_metas[0] = _meta(nonce_pubkey, false, true);
        account_metas[1] = _meta(to_pubkey, false, true);
        account_metas[2] = _meta(RECENT_BLOCKHASHES_ID, false, false);
        account_metas[3] = _meta(RENT_ID, false, false);
        account_metas[4] = _meta(authorized_pubkey, true, false);

        ix.program_id = ID;
        ix.accounts = account_metas;
        ix.data = abi.encodePacked(_u32le(5), Convert.u64le(lamports));
    }

    function authorize_nonce_account(
        bytes32 nonce_pubkey,
        bytes32 authorized_pubkey,
        bytes32 new_authority
    ) public pure returns (Instruction memory ix) {
        ICrossProgramInvocation.AccountMeta[] memory account_metas =
            new ICrossProgramInvocation.AccountMeta[](2);
        account_metas[0] = _meta(nonce_pubkey, false, true);
        account_metas[1] = _meta(authorized_pubkey, true, false);

        ix.program_id = ID;
        ix.accounts = account_metas;
        ix.data = abi.encodePacked(_u32le(7), new_authority);
    }

    function upgrade_nonce_account(bytes32 nonce_pubkey)
        public
        pure
        returns (Instruction memory ix)
    {
        ICrossProgramInvocation.AccountMeta[] memory account_metas =
            new ICrossProgramInvocation.AccountMeta[](1);
        account_metas[0] = _meta(nonce_pubkey, false, true);

        ix.program_id = ID;
        ix.accounts = account_metas;
        ix.data = abi.encodePacked(_u32le(12));
    }

    struct RecipientLamports {
        bytes32 to_pubkey;
        uint64 lamports;
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

    function _encode_string(string memory value) internal pure returns (bytes memory) {
        bytes memory raw = bytes(value);
        return abi.encodePacked(Convert.u64le(uint64(raw.length)), raw);
    }
}
